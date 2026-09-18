import { bodyLimit } from "hono/body-limit";
import { ApiError } from "../lib/api-error";

export const authBodyLimit = bodyLimit({
  maxSize: 4 * 1024,
  onError: () => {
    throw new ApiError(413, "payload_too_large", "The authentication request body is too large");
  },
});
