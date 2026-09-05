import { ArtifactFailure } from "./artifacts.js";
import { MAX_TASK_IMAGE_BYTES } from "./task-attachment-limits.js";
import type { TaskInput } from "./task-contracts.js";

export function decodeTaskImage(image: NonNullable<TaskInput["images"]>[number]): Buffer {
  const dataUri = /^data:([^;,]+);base64,(.+)$/.exec(image.base64);
  const encoded = dataUri?.[2] ?? image.base64;
  const invalid = (): never => { throw new ArtifactFailure("invalid-image-data", "Image data is invalid or too large"); };
  if (dataUri && dataUri[1] !== image.mimeType) return invalid();
  if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return invalid();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || !bytes.length || bytes.length > MAX_TASK_IMAGE_BYTES) return invalid();
  const magic = image.mimeType === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : image.mimeType === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : image.mimeType === "image/webp"
        ? bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
        : bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  return magic ? bytes : invalid();
}
