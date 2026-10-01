import { spawnSync } from "node:child_process";

/**
 * The thumbnail tests need a real ffmpeg. The image build (Dockerfile build stage) installs
 * one, so they always run there; the bare CI runner may not have it, and then they skip.
 */
export const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
