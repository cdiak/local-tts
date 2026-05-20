import esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

(async () => {
  const buildOptions = {
    entryPoints: ["./main.ts"],
    bundle: true,
    outfile: "main.js",
    platform: "node",
    format: "cjs",
    target: "node16",
    sourcemap: false,
    external: ["obsidian"],
    // Note: kokoro-js and its onnxruntime deps will be bundled;
    // large WASM/model files are loaded at runtime from network/cache.
  };

  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("[esbuild] Watching for changes in obsidian-tts...");
  } else {
    await esbuild.build(buildOptions);
    console.log("[esbuild] Build complete. main.js ready.");
  }
})();
