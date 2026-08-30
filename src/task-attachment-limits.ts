// Keep this module dependency free for the frontend bundle; the extra 1 MiB covers the title, description, and JSON envelope.
export const MAX_TASK_IMAGES = 8;
export const MAX_TASK_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TASK_IMAGE_BASE64_LENGTH = Math.ceil(MAX_TASK_IMAGE_BYTES / 3) * 4;
export const MAX_TASK_REQUEST_BYTES = MAX_TASK_IMAGES * MAX_TASK_IMAGE_BASE64_LENGTH + 1024 * 1024;
