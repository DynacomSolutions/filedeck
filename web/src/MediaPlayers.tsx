import { useEffect, useRef, useState } from "react";
import { fileUrl, mediaInfo, transcodeUrl, type MediaInfo } from "./api";

/** Containers and codecs browsers play themselves. Others go straight to the transcoder. */
const NATIVE_VIDEO = new Set(["mp4", "m4v", "webm", "mov", "ogv", "mkv"]);
const NATIVE_AUDIO = new Set(["mp3", "m4a", "aac", "ogg", "oga", "wav", "flac", "opus", "weba"]);
export const VIDEO_EXT = ["mp4", "m4v", "webm", "mov", "mkv", "ogv", "avi", "wmv", "asf", "flv", "mpg", "mpeg", "m2ts", "mts", "vob", "3gp", "3g2", "divx", "rm", "rmvb", "mxf", "f4v"];
export const AUDIO_EXT = ["mp3", "m4a", "aac", "ogg", "oga", "wav", "flac", "opus", "weba", "wma", "aif", "aiff", "ape", "wv", "ac3", "dts", "mka", "amr", "mp2", "au", "caf"];

const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/**
 * Audio or video. The browser gets the file itself first; when its extension is
 * known not to play, or the element reports an error, the agent transcodes on the
 * fly. A transcoded stream cannot be range-requested, so the position slider
 * restarts it at an offset (`t`) read from the file's duration.
 */
export function MediaPlayer({ node, path, name, kind }: { node: string; path: string; name: string; kind: "video" | "audio" }) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const nativeOk = (kind === "video" ? NATIVE_VIDEO : NATIVE_AUDIO).has(ext);
  const [transcode, setTranscode] = useState(!nativeOk);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pos, setPos] = useState(0);
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const el = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    setTranscode(!nativeOk);
    setFailed(false);
    setOffset(0);
    setPos(0);
    setNow(0);
    setInfo(null);
  }, [node, path, nativeOk]);
  useEffect(() => {
    if (!transcode) return;
    let live = true;
    mediaInfo(node, path)
      .then((i) => live && setInfo(i))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [transcode, node, path]);

  const onError = () => {
    if (!transcode) setTranscode(true);
    else setFailed(true);
  };
  const src = transcode ? transcodeUrl(node, path, kind, offset) + (tries ? `&r=${tries}` : "") : fileUrl(node, path);
  const common = { ref: el, src, controls: true, autoPlay: transcode && offset > 0, onError, onTimeUpdate: () => setNow(el.current?.currentTime ?? 0), "aria-label": name };
  const dur = info?.duration ?? null;
  return (
    <div className="pv-media">
      {kind === "video" ? <video key={src} {...common} preload="metadata" /> : <audio key={src} {...common} preload="metadata" />}
      {transcode && (
        <div className="pv-trans">
          <span className="muted">{kind === "video" ? "Transcoded on the fly to H.264/AAC" : "Transcoded on the fly to MP3"}{info?.video ? ` · source ${info.video.codec} ${info.video.width}×${info.video.height}` : ""}</span>
          {dur !== null && (
            <label className="pv-seek">
              <span>Position {clock(offset + now)} / {clock(dur)}</span>
              <input
                type="range"
                min={0}
                max={Math.floor(dur)}
                step={1}
                value={pos}
                aria-label="Seek (restarts the transcoded stream)"
                onChange={(e) => setPos(Number(e.target.value))}
                onPointerUp={() => setOffset(pos)}
                onKeyUp={() => setOffset(pos)}
              />
            </label>
          )}
          {failed && (
            <span role="alert" className="pv-trans-err">
              Could not play this file (the transcoder may be busy, or the file is not valid media).{" "}
              <button className="link" onClick={() => { setFailed(false); setTries((n) => n + 1); }}>Retry</button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
