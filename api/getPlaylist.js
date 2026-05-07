console.log("Force rebuild");

export default async function handler(req, res) {
    let body;

    try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: "Invalid JSON body" });
    }

    const mood = body?.mood || "";

    const length = body?.length || 10;
    const existingSongs = body?.existingSongs || [];

    console.log("BODY RECEIVED:", req.body);

    const existingSongList = existingSongs
        .map(s => `${s.song} - ${s.artist}`)
        .join("\n");

    const lowerMood = mood.toLowerCase();

    const isMusicQuestion =
        lowerMood.includes("who") ||
        lowerMood.includes("what") ||
        lowerMood.includes("band") ||
        lowerMood.includes("artist") ||
        lowerMood.includes("song") ||
        lowerMood.includes("group") ||
        lowerMood.includes("brothers") ||
        lowerMood.includes("singer");

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
                    content: isMusicQuestion
                        ? `You are a highly accurate music expert.

Answer the user's music question directly and conversationally.

If appropriate, suggest similar artists or songs.

User input:
${mood}`
                        : `You are an emotionally intelligent music companion.

FIRST:
Interpret the user's emotional state deeply before selecting songs.

THEN:
Create a playlist that feels emotionally intentional and human-curated.

The user already has these songs:
${existingSongList}

Respond EXACTLY in this format:

1. One short emotional interpretation sentence.

2. 🎧 Songs:
- Song Title - Artist
- Song Title - Artist
- Song Title - Artist
- Song Title - Artist
- Song Title - Artist

3. 🧠 Why this fits:
One short paragraph only.

Rules:
- Recommend REAL songs only
- NEVER invent songs or artists
- NEVER repeat songs
- ALWAYS include ${length} songs
- ALWAYS use format: Song - Artist

Mood: ${mood}`
                }
            ]
        })
    });

    const data = await response.json();

    console.log("OPENAI RESPONSE:", data);

    res.status(200).json(data);
}