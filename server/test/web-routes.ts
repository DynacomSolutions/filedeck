import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Every state-changing request the web client can make, found by reading its source with the TypeScript compiler:
 * calls of fetch(url, { method }) and of the XHR helpers, with the wrappers (post, postJob, trashPost, opReq, ...)
 * followed to their call sites so that the literal operation names are known. Routes are returned as patterns with
 * `:x` for every dynamic segment. A request whose URL cannot be worked out is returned under `unresolved`, so a new
 * way of building one cannot slip past the test that classifies the routes.
 */
export function webWriteRoutes(srcDir: string): { routes: Set<string>; unresolved: string[] } {
  const files = fs.readdirSync(srcDir, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f));
  const sources = files.map((f) => ts.createSourceFile(f, fs.readFileSync(path.join(srcDir, f), "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  const NON_GET = /^(POST|PUT|PATCH|DELETE)$/;

  const varInit = new Map<string, ts.Expression>();
  /** A URL expression as text, with ${expr} kept as `${expr}`; undefined if it is not a string or template. */
  const urlText = (e: ts.Expression | undefined, depth = 0): string | undefined => {
    if (!e) return undefined;
    if (ts.isStringLiteralLike(e)) return e.text;
    if (ts.isTemplateExpression(e)) {
      const file = e.getSourceFile().fileName;
      return (
        e.head.text +
        e.templateSpans
          .map((sp) => {
            // a local that holds a URL prefix (const base = `${nodeBase(n)}/api/upload`) is followed
            const init = ts.isIdentifier(sp.expression) && depth < 3 ? varInit.get(file + "\0" + sp.expression.text) : undefined;
            const inner = init && (ts.isTemplateExpression(init) || ts.isStringLiteralLike(init)) ? urlText(init, depth + 1) : undefined;
            return (inner ?? "${" + sp.expression.getText() + "}") + sp.literal.text;
          })
          .join("")
      );
    }
    return undefined;
  };
  const strLit = (e: ts.Node | undefined) => (e && ts.isStringLiteralLike(e) ? e.text : undefined);
  const norm = (u: string) =>
    u
      .replace(/^\$\{[^}]*nodeBase[^}]*\}/, "")
      .replace(/\?.*$/, "")
      .replace(/\$\{[^}]*\}/g, ":x")
      .replace(/\/+$/, "");

  interface Wrapper {
    name: string;
    params: string[];
    url: string; // text with ${param}
    methodParam?: number;
    method?: string;
  }
  const wrappers: Wrapper[] = [];
  const routes = new Set<string>();
  const unresolved: string[] = [];

  const enclosing = (n: ts.Node): { name: string; params: string[]; defaults: Map<string, string> } | undefined => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isFunctionDeclaration(p)) {
        const holder = p.parent;
        const name = ts.isFunctionDeclaration(p) ? p.name?.text : holder && ts.isVariableDeclaration(holder) ? holder.name.getText() : holder && ts.isPropertyAssignment(holder) ? holder.name.getText() : undefined;
        if (!name) continue;
        const defaults = new Map<string, string>();
        for (const prm of p.parameters) if (prm.initializer && strLit(prm.initializer)) defaults.set(prm.name.getText(), strLit(prm.initializer)!);
        return { name, params: p.parameters.map((x) => x.name.getText()), defaults };
      }
    }
    return undefined;
  };

  const where = (sf: ts.SourceFile, n: ts.Node) => `${sf.fileName}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

  for (const sf of sources) {
    const collect = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) varInit.set(sf.fileName + "\0" + n.name.text, n.initializer);
      ts.forEachChild(n, collect);
    };
    collect(sf);
  }

  // pass 1: the requests themselves
  for (const sf of sources) {
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText();
        let method: ts.Expression | undefined;
        let url: ts.Expression | undefined;
        if (callee === "fetch") {
          url = n.arguments[0];
          const opts = n.arguments[1];
          if (opts && ts.isObjectLiteralExpression(opts)) {
            const m = opts.properties.find((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === "method");
            method = m ? (ts.isPropertyAssignment(m) ? m.initializer : m.name) : undefined;
          }
          if (!method) {
            // no method: a GET, unless the options are not a literal we can read
            if (opts && !ts.isObjectLiteralExpression(opts)) unresolved.push(`${where(sf, n)} fetch with options that are not an object literal`);
            ts.forEachChild(n, visit);
            return;
          }
        } else if (callee === "xhr" || callee === "xhrJson") {
          method = n.arguments[0];
          url = n.arguments[1];
        } else if (/\.open$/.test(callee) && callee !== "window.open" && n.arguments.length >= 2) {
          method = n.arguments[0];
          url = n.arguments[1];
        }
        const encl0 = method && url ? enclosing(n) : undefined;
        // a transport that passes its own parameters on (xhr(method, url), xhrJson, fetch(url, { method })) is judged at its call sites
        if (encl0 && method && url && ts.isIdentifier(method) && ts.isIdentifier(url) && encl0.params.includes(method.text) && encl0.params.includes(url.text)) {
          ts.forEachChild(n, visit);
          return;
        }
        if (method && url) {
          const encl = enclosing(n);
          const mLit = strLit(method) ?? (encl && ts.isIdentifier(method) ? encl.defaults.get(method.text) : undefined);
          const u = urlText(url);
          const dynamicMethod = !strLit(method) && ts.isIdentifier(method) && encl?.params.includes(method.text);
          if (u === undefined && ts.isIdentifier(url) && !encl?.params.includes(url.text)) {
            // a URL held in a variable: its declaration in the same file
            const decl = varInit.get(sf.fileName + "\0" + (url as ts.Identifier).text);
            const t = urlText(decl);
            if (t !== undefined && mLit && NON_GET.test(mLit)) {
              routes.add(norm(t));
              ts.forEachChild(n, visit);
              return;
            }
          }
          if (u === undefined) {
            unresolved.push(`${where(sf, n)} ${callee} with a URL that is not a literal`);
          } else if (dynamicMethod && encl) {
            wrappers.push({ name: encl.name, params: encl.params, url: u, methodParam: encl.params.indexOf((method as ts.Identifier).text) });
          } else if (mLit && NON_GET.test(mLit)) {
            if (encl && encl.params.some((p) => u.includes("${" + p + "}"))) wrappers.push({ name: encl.name, params: encl.params, url: u, method: mLit });
            else routes.add(norm(u));
          } else if (!mLit) {
            unresolved.push(`${where(sf, n)} ${callee} with a method that is not a literal`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // pass 2: the call sites of the wrappers give their literal operation names
  for (const sf of sources) {
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : n.expression.getText().replace(/<.*$/, "");
        for (const w of wrappers.filter((x) => x.name === callee)) {
          let u = w.url;
          let ok = true;
          w.params.forEach((p, i) => {
            if (!u.includes("${" + p + "}")) return;
            const a = n.arguments[i];
            const lit = strLit(a) ?? urlText(a);
            u = u.split("${" + p + "}").join(lit ?? (a === undefined ? "" : ":x")); // not a literal: a dynamic segment (an id)
          });
          const method = w.method ?? strLit(n.arguments[w.methodParam ?? -1]) ?? (w.methodParam !== undefined ? "GET" : undefined);
          if (!ok) unresolved.push(`${where(sf, n)} ${callee}(...) with an operation that is not a literal`);
          else if (method && NON_GET.test(method)) routes.add(norm(u));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // a wrapper that is never called with a method that changes state contributes nothing; one with a fixed method but no call site is reported
  for (const w of wrappers) if (w.method && !sources.some((sf) => sf.text.includes(w.name + "(") || sf.text.includes(w.name + "<"))) unresolved.push(`${w.name}: a state-changing wrapper that is never called`);
  return { routes, unresolved };
}
