export const extensionDirectory = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/').filter(Boolean).pop());
