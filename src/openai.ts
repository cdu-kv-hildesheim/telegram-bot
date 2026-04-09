import type { Env } from "./types";

export async function transcribeVoice(
  env: Env,
  audioUrl: string,
): Promise<string> {
  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) {
    throw new Error(`Failed to download voice: ${audioResponse.status}`);
  }
  const audioBlob = await audioResponse.blob();

  const formData = new FormData();
  formData.append("file", audioBlob, "voice.ogg");
  formData.append("model", "gpt-4o-mini-transcribe");
  formData.append("language", "de");

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: formData,
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Whisper error: ${response.status} – ${error}`);
  }

  return ((await response.json()) as { text: string }).text;
}
