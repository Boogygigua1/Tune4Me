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
    const avoidSongs = body?.avoidSongs || [];
    const likedSongs = body?.likedSongs || [];

    let songReference = "";
    let artistReference = "";

    const byMatch = mood.match(/(.+)\s+by\s+(.+)/i);

    if (byMatch) {
        songReference = byMatch[1]?.trim();
        artistReference = byMatch[2]?.trim();
    }

    const forcedAnchorSong =
        songReference && artistReference
            ? `- ${songReference} - ${artistReference}`
            : "";

    console.log("BODY RECEIVED:", req.body);

    const existingSongList = existingSongs
        .map(s => `${s.song} - ${s.artist}`)
        .join("\n");

    const avoidSongList = avoidSongs
        .map(s => `${s.song} - ${s.artist}`)
        .join("\n");

    const likedSongList = likedSongs
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
        "90s",
        "2000s",
        "2010s",
        "2020s",
        "festival",
        "concert",
        "outside lands",
        "coachella",
        "indie",
        "edm",
        "alternative",
        "playlist",
        "vibes"
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
                        content: `You are an expert human music curator with deep knowledge of music culture, festival culture, nostalgia, underground music discovery, emotional storytelling, and generational music trends.

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
- danceability level
- club/festival energy
- rhythmic intensity
- rhythmic emotional movement when appropriate
- atmospheric momentum when appropriate
- underground or electronic influence only when culturally relevant

THEN:
Create a playlist that feels emotionally intentional and human-curated.

The playlist should balance:
- emotional connection
- festival energy
- cultural authenticity
- emotional progression
- nighttime emotional atmosphere
- emotionally memorable moments
- cinematic feeling

Avoid emotionally flat or repetitive playlists, but allow acoustic, folk, soul, Americana, intimate, or reflective music when culturally or emotionally appropriate to the user's reference.

When the user EXPLICITLY suggests nightlife, club culture, rave energy, festival atmosphere, futuristic emotion, warehouse atmosphere, or electronic momentum:

- strongly prioritize house, techno, electronic, indie dance, progressive electronic, melodic techno, festival electronica, synth-driven tracks, and rhythm-forward music

- prefer songs with movement and pulse over acoustic introspection

- maintain emotional intelligence without losing rhythmic momentum

IMPORTANT:

If the user references a specific artist, band, soundtrack, decade, genre, or cultural music reference:

PRIORITIZE:
- musical similarity
- genre similarity
- era accuracy
- instrumentation
- vocal style
- cultural association
- artist lineage

The playlist MUST remain culturally and musically connected to the original reference.

Do NOT drift too far into unrelated emotional interpretations, cinematic electronic music, ambient music, or modern mood-based recommendations unless the user specifically asks for reinterpretation or genre blending.

Musical identity comes BEFORE emotional progression.

- If the user's reference strongly implies a specific era, cultural moment, or nostalgic time period, preserve the musical identity of that era throughout most of the playlist.

- Do not modernize the playlist too aggressively unless the user explicitly requests reinterpretation, remix energy, or modern crossover discovery.

- Era authenticity should remain stronger than progression pressure when nostalgia is central to the request.

- When a request references classic film, Americana, folk, soul, emotional realism, or older cultural nostalgia, preserve the emotional and musical textures of that era.

- Avoid interpreting nighttime, loneliness, nostalgia, or cinematic atmosphere as modern synthwave, EDM, indie-electronic, or nightlife energy unless explicitly requested.

- Emotional realism and cultural authenticity are more important than modern atmospheric reinterpretation.

IMPORTANT CULTURAL GUIDELINES:

- If the user writes in another language, preserve the emotional meaning of their words before selecting songs.

- Do not stereotype users based on language, country, or culture.

- Language should act as emotional context, not a restriction.

- Include culturally relevant music naturally when emotionally appropriate.

- Allow emotionally accurate cross-cultural discovery when it fits the mood.

- Do not force all recommendations into the user's language.

- Balance:
  • familiarity
  • emotional authenticity
  • cultural respect
  • eclectic discovery

- Treat non-English music with the same emotional depth and importance as English-language music.

- Focus on emotional truth, not superficial genre or regional assumptions.

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

The user disliked or rejected these songs:
${avoidSongList}

Do NOT recommend these songs again.
Avoid recommending songs that are extremely similar in sound, mood, or artist style unless clearly justified.

The user strongly liked these songs:
${likedSongList}

Strongly prioritize learning from the user's liked and disliked songs.

Avoid repeating recommendation patterns the user has already rejected.

Liked songs should heavily influence future emotional tone, genre direction, cultural texture, and atmospheric style.

User feedback should strongly influence recommendations, but should not override culturally or emotionally important aspects of the user's current reference or request.

Respond EXACTLY in this format:

1. One casual sentence about the overall vibe or mood.
Sound natural and conversational.
Avoid therapy-style emotional analysis.

2. 🎧 Songs:
${forcedAnchorSong}

Continue the playlist naturally from this anchor song.

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
Use modern conversational language that feels relatable across generations.

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

- Some user references may represent larger cultural, cinematic, emotional, or generational associations instead of direct song searches.

- Understand famous emotional associations connected to films, festivals, eras, nightlife, internet culture, scenes, and iconic songs.

- If a cultural reference strongly implies a famous emotional anchor song, include it naturally in the playlist.

Examples:
- "Midnight Cowboy" may imply "Everybody's Talkin'"
- "Drive soundtrack" may imply synthwave or neon-night artists
- "Outside Lands" may imply current festival culture and emotionally atmospheric artists

- Prioritize cultural understanding over literal keyword matching when appropriate.

- Users may describe music imperfectly from memory instead of using exact names.

- Use contextual reasoning and best-match thinking before generating recommendations.

- If a clue strongly matches a known artist or band,
  include accurate related songs in the playlist.

- Preserve exact artist names, punctuation, capitalization, and formatting.

- Never shorten, simplify, or partially output artist names.

Examples:
- a-ha
- blink-182
- AC/DC
- Earth, Wind & Fire
- Florence + The Machine

- Maintain official artist formatting exactly as commonly recognized.

IMPORTANT:

If the user directly references a real song, artist, band, album, genre, or music scene:

- FIRST acknowledge the emotional and musical anchor directly.

- If the user directly references a real song, ALWAYS include that exact song somewhere in the playlist unless explicitly told not to.

- The playlist should feel like:
  "I understand what you mean — now let me take you somewhere from there."

- Users should immediately feel understood before the playlist becomes exploratory.

- Do NOT abandon the user's original reference too quickly.

- Balance:
  • familiarity
  • emotional validation
  • discovery
  • surprise
  • atmosphere

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