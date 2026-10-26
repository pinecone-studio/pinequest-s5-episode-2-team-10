# Training the E2B model on Kaggle

The split that works best for us:

| Step | Where | Why |
|---|---|---|
| 1. Make the training data | **GPU PC** | The teacher (Gemma 4 E4B in Ollama) is already there, and pitches never leave our machine except as the final data file. |
| 2. Fine-tune E2B | **Kaggle** (free T4, 16 GB) | The 4060's 8 GB is busy with BuzzASR and Gemma during the demo. |
| 3. Load the model and benchmark it | **GPU PC** | Only the 4060 gives speed numbers that match the demo. |

Kaggle gives about 30 GPU hours per week, and a session runs for up to 12 hours. One training run on a few hundred examples should take well under that, but nobody has run it there yet. Expect to fix something on the first run.

## 1. Make the data (GPU PC)

```bash
# From the repo root. Uses the local Ollama with gemma4:e4b.
OLLAMA_URL=http://localhost:11434 OLLAMA_TOKEN= PITCH_EMBEDDINGS=none \
python -m training.speed.make_data --transcripts data/transcripts --synthetic 300 --out data/speed
```

- `data/transcripts/` holds one `.txt` per real pitch. Only include recordings whose speakers agreed to it.
- Each answer takes about 25–35 s on the 4060, so 300 pitches take about 3 hours. Run it overnight, or start with `--synthetic 50` to try the whole path first.
- The result is `data/speed/train.jsonl` and `data/speed/test.jsonl`. They contain transcripts, so keep the Kaggle dataset **private**, and never commit them (`data/` is git-ignored).

## 2. Kaggle account and notebook (once)

1. Sign in at kaggle.com, then **Settings → Phone verification**. Without it there is no GPU or internet in notebooks.
2. **Create → New Notebook.**
3. In the right-hand panel, under **Session options**:
   - **Accelerator:** `GPU T4 x2`. The script uses one of the two GPUs. Don't pick P100: Unsloth's kernels don't support it.
   - **Internet:** on.
   - **Persistence:** "Files only", so `/kaggle/working` survives a restart.

## 3. Upload the data as a private dataset

1. **Create → New Dataset**, upload `train.jsonl` and `test.jsonl`, name it `saylo-speed`, and keep it **Private**.
2. In the notebook, **Add Input → Your Datasets → saylo-speed**. It appears at `/kaggle/input/saylo-speed/`. Check the exact path with `!ls /kaggle/input`.

Each new batch of data is a **New Version** of the same dataset, so the notebook doesn't change.

## 4. Notebook cells

```python
# Cell 1: the code (the repo is public, so no token is needed)
!git clone --depth 1 https://github.com/pinecone-studio/pinequest-s5-episode-2-team-10.git /kaggle/working/saylo
%cd /kaggle/working/saylo
!nvidia-smi --query-gpu=name,memory.total --format=csv
```

```python
# Cell 2: training libraries (about 2–4 minutes)
!pip install -q --upgrade unsloth unsloth_zoo trl datasets
```

```python
# Cell 3: train, then export the GGUF (training time depends on the amount of data;
# the GGUF export builds llama.cpp first, which adds about 5–10 minutes)
import os
os.environ["CUDA_VISIBLE_DEVICES"] = "0"   # one GPU; Unsloth doesn't split across both
!python -m training.speed.train_e2b --data /kaggle/input/saylo-speed --out /kaggle/working/model --epochs 2
```

```python
# Cell 4: keep only what we need to download
!rm -rf /kaggle/working/model/checkpoints
!ls -lh /kaggle/working/model /kaggle/working/model/gguf
```

**Long runs:** instead of keeping the browser open, use **Save Version → Save & Run All (Commit)**. It runs in the background, and the files appear under the version's **Output** tab when it finishes.

**If it runs out of memory:** add `--max-seq 6144` or `--rank 8`. Don't go below 6144: a prompt plus its answer is 4,300–6,100 tokens, and anything longer is cut off.

## 5. Bring the model to the GPU PC

1. In the notebook's **Output** panel (or the committed version's **Output** tab), download `model/gguf/*.gguf` (Q4_K_M, about 3 GB) and `model/Modelfile`.
2. Put them on the PC in `B:\pinequest-data\models\pitchcoach-e2b\`, keeping the `gguf\` folder next to the `Modelfile`.
3. Copy the chat template from the base model into the Modelfile: run `ollama show gemma4:e2b --modelfile` and paste its `TEMPLATE` and `PARAMETER stop` lines below the `FROM` line.
4. Create the model, then compare it with the others:

```bash
cd B:/pinequest-data/models/pitchcoach-e2b
ollama create pitchcoach-e2b -f Modelfile

cd "<repo>"
OLLAMA_URL=http://localhost:11434 OLLAMA_TOKEN= PITCH_EMBEDDINGS=none \
python -m training.speed.benchmark --models gemma4:e4b gemma4:e2b pitchcoach-e2b --data data/speed
```

Leave the voice server running during the benchmark, so the numbers match the demo.

## What not to upload to Kaggle

- The `.env` file or any key. The notebook needs none.
- Raw audio. Training uses text only.
- Pitches from people who didn't agree to their recordings being used.
