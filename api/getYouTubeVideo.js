export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    let body;
    try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: "Invalid JSON body" });
    }

    const query = body.query;

    if (!query) {
        return res.status(400).json({ error: "Missing query" });
    }

    try {
        const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

        const response = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}&maxResults=1&type=video`
        );

        const data = await response.json();

        if (!data.items || data.items.length === 0) {
            return res.status(404).json({ error: "No video found" });
        }

        const videoId = data.items[0].id.videoId;

        const videoDetailsResponse = await fetch(
            `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`
        );

        const videoDetails = await videoDetailsResponse.json();

        const duration = videoDetails.items[0].contentDetails.duration;

        return res.status(200).json({
            videoId,
            duration
        });

    } catch (error) {
        return res.status(500).json({ error: "Server error", details: error.message });
    }
}