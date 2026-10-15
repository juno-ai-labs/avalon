import { createCloudflareTestBinding } from "./cloudflare-test";

/**
 * An Images binding that answers every transform with `output` as a JPEG.
 * Images cannot run locally, so this stands in for the downscale production
 * always has.
 */
export function fakeImagesBinding(output: Uint8Array): ImagesBinding {
  const body = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
  return createCloudflareTestBinding<ImagesBinding>({
    input() {
      const transformer = {
        transform() { return transformer; },
        async output() {
          return {
            image() { return new Blob([body]).stream(); },
            contentType() { return "image/jpeg"; },
            response() { return new Response(body, { headers: { "content-type": "image/jpeg" } }); },
          };
        },
      };
      return transformer;
    },
  });
}
