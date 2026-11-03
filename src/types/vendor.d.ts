// Ambient declarations for node-forge and qrcode. Call sites annotate concrete usage so TypeScript accepts these untyped dependencies.
declare module "node-forge" {
  const forge: any;
  export default forge;
}

declare module "qrcode" {
  const QRCode: any;
  export default QRCode;
}
