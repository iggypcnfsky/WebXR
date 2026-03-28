declare module "draco3d" {
  type DracoEmscriptenModuleOptions = { wasmBinary?: ArrayBuffer };
  const draco3d: {
    createEncoderModule: (options?: DracoEmscriptenModuleOptions) => Promise<unknown>;
    createDecoderModule: (options?: DracoEmscriptenModuleOptions) => Promise<unknown>;
  };
  export default draco3d;
}
