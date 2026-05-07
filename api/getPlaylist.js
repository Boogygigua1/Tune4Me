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
                    content: `You are an emotionally intelligent music companion.

FIRST:
Interpret the user's emotional state deeply before selecting songs.

Identify:
- emotional tone
- loneliness level
- nostalgia level
- emotional conflict
- desire for comfort vs empowerment
- emotional energy level

THEN:
Create a playlist that feels emotionally intentional and human-curated.

The playlist must follow this emotional progression:
1. Validation
2. Reflection
3. Nostalgia or familiarity
4. Unexpected emotional connection
5. Hopeful transition or release

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
- Avoid generic Spotify-style recommendations
- Avoid repetitive artists
- Prefer emotionally specific songs
- Mix familiar songs with forgotten gems
- Avoid obvious songs unless emotionally perfect
- Songs must feel intentionally selected
- Recommendations should feel personal, cinematic, nostalgic, and emotionally accurate
- NEVER repeat any songs already listed
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