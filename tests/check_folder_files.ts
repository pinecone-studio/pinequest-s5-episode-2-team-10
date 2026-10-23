import assert from "node:assert/strict";
import {
  attachAudio,
  attachSlide,
  audioFileError,
  AUDIO_MAX_BYTES,
  detachAudio,
  legacyAudioKey,
  normalizeFolder,
  selectAudio,
  selectedAudio,
  slideStorageKey,
} from "../web/src/lib/folderFiles.ts";

const legacy = normalizeFolder({
  id: "folder-1",
  name: "Pitch",
  slideName: "deck.pdf",
  audioName: "take.webm",
});
assert.equal(legacy.slide?.id, "folder-1:slide");
assert.equal(legacy.slide?.storageKey, slideStorageKey("folder-1"));
assert.equal(legacy.slide?.folderId, "folder-1");
assert.equal(legacy.audios?.length, 1);
assert.equal(legacy.audios?.[0].storageKey, legacyAudioKey("folder-1"));
assert.equal(selectedAudio(legacy)?.filename, "take.webm");

const replaced = attachSlide(legacy, { name: "new.pdf", type: "application/pdf" }, "2026-10-23T00:00:00.000Z");
assert.equal(replaced.slide?.id, legacy.slide?.id);
assert.equal(replaced.slide?.storageKey, legacy.slide?.storageKey);
assert.equal(replaced.slideName, "new.pdf");

const first = attachAudio(replaced, { name: "a.wav", type: "audio/wav", durationS: 12 }, "audio-a", "2026-10-23T01:00:00.000Z");
const second = attachAudio(first, { name: "b.mp3", type: "audio/mpeg", durationS: 40 }, "audio-b", "2026-10-23T02:00:00.000Z");
assert.equal(second.audios?.length, 3);
assert.equal(second.audioId, "audio-b");
assert.equal(second.audioName, "b.mp3");
assert.equal(second.audios?.every((audio) => audio.folderId === "folder-1"), true);

const again = attachAudio(second, { name: "b-fixed.mp3", type: "audio/mpeg", durationS: 41 }, "audio-b", "2026-10-23T03:00:00.000Z");
assert.equal(again.audios?.length, 3);
assert.equal(again.audios?.find((audio) => audio.id === "audio-b")?.filename, "b-fixed.mp3");

const chosen = selectAudio(again, "audio-a");
assert.equal(chosen.audioName, "a.wav");
assert.equal(selectedAudio(chosen)?.id, "audio-a");

const removed = detachAudio(chosen, "audio-a");
assert.equal(removed.storageKey?.endsWith("audio-a"), true);
assert.equal(removed.folder.audios?.some((audio) => audio.id === "audio-a"), false);
assert.equal(removed.folder.audioName, "b-fixed.mp3");

const cleared = detachAudio(detachAudio(removed.folder, "audio-b").folder, "folder-1:audio");
assert.equal(cleared.folder.audios?.length, 0);
assert.equal(cleared.folder.audioName, null);
assert.equal(normalizeFolder(cleared.folder).audios?.length, 0);

assert.equal(audioFileError({ name: "notes.txt", type: "text/plain", size: 10 }), "type");
assert.equal(audioFileError({ name: "big.wav", type: "audio/wav", size: AUDIO_MAX_BYTES + 1 }), "size");
assert.equal(audioFileError({ name: "ok.webm", type: "audio/webm;codecs=opus", size: 1000 }), null);

console.log("folder-files-ok");
