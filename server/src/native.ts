import fs from "node:fs/promises";
import path from "node:path";

/**
 * Where `npm run build` puts the helpers it compiles (server/scripts/build-native.mjs): server/dist/native, which is the same
 * place from src/ (development) and from dist/ (built). It is a fixed place beside the running code and `PATH` is never searched.
 * It is as trusted as that code: in the image the served folder is mounted elsewhere, and a development start that serves a folder
 * which holds its own checkout already lets every client change the code it runs.
 */
export const BUILT_NATIVE_DIR = path.resolve(import.meta.dirname, "../dist/native");

export const executable = (p: string): Promise<boolean> => fs.access(p, fs.constants.X_OK).then(() => true, () => false);

/**
 * The launcher (or another native helper) to use. `fromEnv` (the variable's value) when it is set: used as given, with no fallback,
 * so a wrong value is seen as a missing launcher. Otherwise the installed one (`installed`, as in the image), otherwise the one built
 * beside the code (`builtDir`). Returns the first candidate even when none can be run, so the caller reports what it looked for.
 */
export async function locateHelper(name: string, fromEnv: string | undefined, installed = `/usr/local/bin/${name}`, builtDir = BUILT_NATIVE_DIR): Promise<string> {
  if (fromEnv !== undefined) return fromEnv;
  if (await executable(installed)) return installed;
  const built = path.join(builtDir, name);
  return (await executable(built)) ? built : installed;
}
