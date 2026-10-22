from fastapi import FastAPI

app = FastAPI()

@app.get("/")
def root():
    return {"message": "Saylo backend ажиллаж байна"}

@app.get("/health")
def health():
    return {"status": "ok"}