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
                    content: `You are an emotionally intelligent music curator.

Your job is to recommend songs that feel deeply personal, emotionally accurate, nostalgic, cinematic, meaningful, and sometimes unexpectedly perfect.

The user already has these songs:
${existingSongList}

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

Rules:
- Recommend REAL songs only
- NEVER invent songs or artists
- Prefer emotionally powerful songs over generic mainstream choices
- Mix recognizable songs with overlooked or forgotten gems
- Avoid repetitive Spotify-style recommendations
- Avoid overly obvious songs unless they perfectly fit the mood
- Prioritize emotional atmosphere and emotional storytelling
- Include songs people may have forgotten existed
- Vary decades and artist selection naturally
- Recommendations should feel human-curated, not algorithmic
- Recommend songs likely available on YouTube
- NEVER repeat any songs already listed
- ALWAYS include ${length} songs
- ALWAYS use format: Song - Artist
- Each song must feel emotionally intentional

Mood: ${mood}`
                }
            ]
        })
    });

    const data = await response.json();

    console.log("OPENAI RESPONSE:", data);

    res.status(200).json(data);
}