// node-forge y qrcode no publican tipos. El uso concreto está anotado en el
// código que los llama; aquí solo se declara el módulo para que tsc lo acepte.
declare module "node-forge" {
  const forge: any;
  export default forge;
}

declare module "qrcode" {
  const QRCode: any;
  export default QRCode;
}
