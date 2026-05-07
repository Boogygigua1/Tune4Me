console.log("Force rebuild");

export default async function handler(req, res) {
    let body;

    try {
        body = typeof req.body === "string"
            ? JSON.parse(req.body)
            : req.body;
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

        const musicClueWords = [
    "band",
    "group",
    "singer",
    "song",
    "lyrics",
    "50s",
    "60s",
    "70s",
    "80s",
    "90s"
];

const hasMusicClue = musicClueWords.some(word =>
    mood.toLowerCase().includes(word)
);

let enhancedMood = mood;

if (hasMusicClue) {
    enhancedMood = `
The user may be referring to a real artist, band, or song from music history.

Interpret vague clues intelligently.

User clue:
"${mood}"
`;
}

    const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
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
${hasMusicClue
? "If the user gives clues about music history, artists, bands, decades, lyrics, or famous songs, intelligently identify likely matches before generating recommendations."
: "Interpret the user's emotional state deeply before selecting songs."}

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

1. Emotional validation
2. Reflection/introspection
3. Familiar emotional connection
4. Nostalgic memory trigger
5. Hidden gem or unexpected match
6. Deep emotional immersion
7. Emotional tension release
8. Comfort or reassurance
9. Regaining emotional energy
10. Hopeful transition or empowerment

The user already has these songs:
${existingSongList}

Respond EXACTLY in this format:

1. One casual sentence about the overall vibe or mood.
Sound natural and conversational.
Avoid therapy-style emotional analysis.

2. 🎧 Songs:
- Song Title - Artist
- Song Title - Artist
- Song Title - Artist
- Song Title - Artist
- Song Title - Artist

3. 🧠 Why this fits:
Briefly explain the vibe in a casual, natural way.

Keep it short.
1-2 sentences maximum.

Sound like a real music fan talking to a friend.
Avoid overly dramatic or therapy-style language.

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

- Recognize vague, incomplete, misspelled, or conversational references to real artists, bands, songs, and music history.

- Users may describe music imperfectly from memory instead of using exact names.

- Use contextual reasoning and best-match thinking before generating recommendations.

- If a clue strongly matches a known artist or band,
  include accurate related songs in the playlist.

Mood: ${enhancedMood}`
                    }
                ]
            })
        }
    );

    const data = await response.json();

    console.log("OPENAI RESPONSE:", data);

    res.status(200).json(data);
}