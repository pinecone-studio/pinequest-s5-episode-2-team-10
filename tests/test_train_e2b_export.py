"""The training script's export step: picks the right GGUF and writes a Modelfile (no GPU needed)."""

from pathlib import Path

from training.speed.train_e2b import export_gguf, pick_gguf


def touch(path: Path, size: int = 10) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"0" * size)
    return path


def test_pick_gguf_prefers_q4_k_m_over_projector_and_f16(tmp_path):
    files = [
        touch(tmp_path / "mmproj-model-f16.gguf"),
        touch(tmp_path / "model.F16.gguf", 100),
        touch(tmp_path / "model.Q4_K_M.gguf", 30),
    ]
    assert pick_gguf(files).name == "model.Q4_K_M.gguf"


def test_pick_gguf_falls_back_to_smallest_model_file(tmp_path):
    files = [touch(tmp_path / "a-f16.gguf", 100), touch(tmp_path / "b.gguf", 30), touch(tmp_path / "mmproj.gguf", 1)]
    assert pick_gguf(files).name == "b.gguf"
    assert pick_gguf([touch(tmp_path / "mmproj-only.gguf")]) is None


class FakeModel:
    """Writes files like Unsloth versions that add a `_gguf` suffix to the folder."""

    def save_pretrained_gguf(self, folder, tokenizer, quantization_method):
        out = Path(folder + "_gguf")
        touch(out / "gemma-4-e2b-it.Q4_K_M.gguf", 30)
        touch(out / "mmproj-gemma-4-e2b-it.gguf", 5)


def test_export_writes_modelfile_pointing_at_the_quantized_model(tmp_path):
    assert export_gguf(FakeModel(), None, tmp_path) == 0
    modelfile = (tmp_path / "Modelfile").read_text(encoding="utf-8")
    assert modelfile.startswith("FROM ./gguf_gguf/gemma-4-e2b-it.Q4_K_M.gguf\n")


class NoOutputModel:
    def save_pretrained_gguf(self, folder, tokenizer, quantization_method):
        pass


def test_export_reports_failure_when_nothing_is_written(tmp_path):
    assert export_gguf(NoOutputModel(), None, tmp_path) == 1
    assert not (tmp_path / "Modelfile").exists()
