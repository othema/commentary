type GeminiResponse = {
	candidates?: Array<{
		content?: {
			parts?: Array<{
				text?: string;
			}>;
		};
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		totalTokenCount?: number;
	};
};

export type LlmUsage = {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
};

const defaultModel = "gemini-3-flash-preview";
const apiUrl = "https://generativelanguage.googleapis.com/v1beta/models";

export async function sendLlmRequest(
	prompt: string,
	apiKey: string,
	model = defaultModel,
	onUsage?: (usage: LlmUsage) => void
): Promise<string> {
	if (!apiKey.trim()) {
		throw new Error("A Google AI Studio API key is required.");
	}

	const response = await fetch(
		`${apiUrl}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				contents: [
					{
						parts: [{ text: prompt }],
					},
				],
			}),
		}
	);

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Google AI Studio request failed (${response.status}): ${errorBody}`);
	}

	const data = (await response.json()) as GeminiResponse;
	onUsage?.(data.usageMetadata ?? {});
	const text = data.candidates?.[0]?.content?.parts
		?.map(({ text: partText }) => partText ?? "")
		.join("")
		.trim();

	if (!text) {
		throw new Error("Google AI Studio returned no text response.");
	}

	return text;
}
