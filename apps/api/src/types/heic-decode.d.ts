declare module "heic-decode" {
  interface DecodedHeicImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  export default function decodeHeic(input: { buffer: ArrayBuffer }): Promise<DecodedHeicImage>;
}
