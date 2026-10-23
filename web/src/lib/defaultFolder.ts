import type { FolderAudio, FolderSlide } from "./folderFiles";

/** The shared starter folder. Files live in web/public/defaults/ok. */
export const SHARED_FOLDER_ID = "4b60dfb0-da14-41db-8244-0f2cc3455d03";
const AUDIO_ID = "b1a4bb6e-a93c-4319-8ec5-3a21e74e520f";
const SAVED_AT = "2026-10-23T05:00:00.000Z";

const slide: FolderSlide = {
  id: `${SHARED_FOLDER_ID}:slide`,
  folderId: SHARED_FOLDER_ID,
  title: "Pinequest ep2.pdf",
  filename: "Pinequest ep2.pdf",
  storageKey: `${SHARED_FOLDER_ID}:slide`,
  fileType: "application/pdf",
  createdAt: SAVED_AT,
};

const audio: FolderAudio = {
  id: AUDIO_ID,
  folderId: SHARED_FOLDER_ID,
  filename: "Бичлэг.webm",
  storageKey: `${SHARED_FOLDER_ID}:audio:${AUDIO_ID}`,
  fileType: "audio/webm",
  durationS: null,
  createdAt: SAVED_AT,
};

export const SHARED_FOLDER = {
  id: SHARED_FOLDER_ID,
  name: "ok",
  slideName: slide.filename,
  audioName: audio.filename,
  audioId: AUDIO_ID,
  slide,
  audios: [audio],
};

/** Public files used when this browser has not stored the folder's bytes yet. */
export const SHARED_BLOBS: Record<string, { url: string; type: string }> = {
  [slide.storageKey]: { url: "/defaults/ok/pinequest-ep2.pdf", type: "application/pdf" },
  [audio.storageKey]: { url: "/defaults/ok/recording.webm", type: "audio/webm" },
};

export const SHARED_SPEECH =
  "Тэгээд би одоо манай ноён. Юу гэдэг юм ээ төслийг танилцуулах гэж байна л даа Очлоорой би чамайг сайн шаналж байна. өрөх өдөр бараг үнэтэйгүй шөнө хоёр цаг хүртэл биеийн ажил хийгээд нөгөө. онгин үүдэнд нь таарахгүй байсан юм тиймээс энэ цэнхэр өнгө 3 удаа салсан. За тэгээд манатусын нэр пичкоч. пичгоч тийм ээ пичекоч Өнөөдөр ийм зүйл ойлгомжтой байх гэж бодож байна л даа. асуудал гэвэл. олон. хүмүүс ер нь хүмүүсийн айхтар нөгөөд сандардаг тиймээс би өөрөө ч гэсэн сандарч одоо ч гэсэн амьдарч байна. Манай ангид нэг хүүхэд байсан л даа тэр илтгэл тавихдаа өөргилчин гэж цаас хун шагадаггүй сан хатагтайтай одоо тэд. солонгос орж байгаа л даа. Бас айх амьдарч байгаа юм. өөр. өөрийн өөрийгөө сонсож чаддаггүй тийм ээ өөр өөрийгөө сонсож чаддаг уу. Ээ. за сайн байна уу. тэгээд би одоо манапагийн анд юугаа гэдэгт тэд танилцах гэж байна л даа Би жаахан сайнаар байна л даа. өдөр шөнө жаахан пигма ослодыг одоо л. оройнхоо өдөр нь унтчихсан юм энэ цэнхэр өнгийг 3 удаа сонссон. таадаг юм хан таслин нэр пичкоч тийм ээ пичгоч. яах вэ энэ нь өөрөө ойлгомжтой байх гэж бодож байна л даа. Хүмүүс ирэхдээ. өөр стандартыг дэмий биш гэсэн бодол минь. юу ярьж. л ардын асуудал. Тэгэхэд хүмүүс. бэлдэгтэй өөрийгөө өөрийн гэдгийг сонсож чадвал тэрийгээ Манайхан гэр шид гээд. Энэ нь таны хувьд хамгийн чухал зүйл юм.";
