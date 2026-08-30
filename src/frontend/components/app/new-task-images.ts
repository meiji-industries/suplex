import { MAX_TASK_IMAGES, MAX_TASK_IMAGE_BYTES } from "../../../task-attachment-limits.js";

const acceptedImageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function newTaskImageError(existingCount: number, files: File[]): string {
  if (existingCount + files.length > MAX_TASK_IMAGES) return "At most eight images may be attached";
  if (files.some((file) => !acceptedImageTypes.includes(file.type))) return "Only PNG, JPEG, WebP, and GIF images are accepted";
  if (files.some((file) => file.size > MAX_TASK_IMAGE_BYTES)) return "Each image must be smaller than 8 MB";
  return "";
}
