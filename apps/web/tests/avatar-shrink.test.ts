// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { shrinkImage } from "../components/app/entity-avatar.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("a large photo is drawn at most 512 px on its longest edge and saved as JPEG", async () => {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4032, height: 3024, close })));
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  let size: [number, number] | undefined;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback, type) {
    size = [this.width, this.height];
    callback(new Blob(["x"], { type: type ?? "" }));
  });

  const shrunk = await shrinkImage(new Blob(["photo"], { type: "image/jpeg" }));

  expect(size).toEqual([512, 384]);
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 512, 384);
  expect(shrunk.type).toBe("image/jpeg");
  expect(close).toHaveBeenCalled();
});
