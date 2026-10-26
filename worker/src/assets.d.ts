// Binary assets bundled into the Worker (see [[rules]] in wrangler.toml).
declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
