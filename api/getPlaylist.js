
console.log("Force rebuild");
export default async function handler(req, res) {

	let body;

try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
} catch {
    return res.status(400).json({ error: "Invalid JSON body" });
}

const mood = body?.mood || "";
const style = body?.style || "";
const length = body?.length || 5;

    console.log("BODY RECEIVED:", req.body);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + process.env.OPENAI_API_KEY
        },
        body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
content: `You are a music assistant.

Respond EXACTLY in this format:

1. One short warm sentence.

2. 🎧 Songs:
- Song Title - Artist
- Song Title - Artist
- Song Title - Artist
- Song Title - Artist
- Song Title - Artist

3. 🧠 Why this fits:
One short explanation.

User feels: ${mood} and prefers ${style}

Rules:
- ALWAYS include 5 songs
- ALWAYS use format: Song - Artist
- NEVER skip the songs section
- NEVER leave it empty
				`}            ]
        })
    });

const data = await response.json();

console.log("OPENAI RESPONSE:", data);

res.status(200).json(data);
}