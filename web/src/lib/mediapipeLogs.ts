// MediaPipe's WebAssembly writes plain status lines, such as "INFO: Created TensorFlow Lite XNNPACK
// delegate for CPU.", with console.error. In development Next shows every console.error as an error,
// so turning on the camera looked broken. Those lines go to console.info instead; anything else is
// still a real error.

const INFO_LINE = /^(INFO:|I\d{4} )/;
let quieted = false;

export function isMediaPipeInfo(first: unknown): boolean {
  return typeof first === "string" && INFO_LINE.test(first);
}

/** Call before loading a MediaPipe model. Safe to call more than once. */
export function quietMediaPipeInfo(): void {
  if (quieted || typeof console === "undefined") return;
  quieted = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (isMediaPipeInfo(args[0])) console.info(...args);
    else original(...args);
  };
}
