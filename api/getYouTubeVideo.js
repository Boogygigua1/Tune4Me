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

    const query = body?.query;

    if (!query) {
        return res.status(400).json({ error: "Missing query" });
    }

    try {
        const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

        if (!YOUTUBE_API_KEY) {
            return res.status(500).json({ error: "Missing YouTube API key" });
        }

        const searchResponse = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`
        );

        const searchData = await searchResponse.json();

        if (!searchData.items || searchData.items.length === 0) {
            return res.status(200).json({ error: "No video found" });
        }

        const videoIds = searchData.items
            .map(item => item?.id?.videoId)
            .filter(Boolean)
            .join(",");

        if (!videoIds) {
            return res.status(200).json({ error: "No video found" });
        }

        const response = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}&maxResults=5&type=video`
);

        const detailsData = await detailsResponse.json();

        if (!detailsData.items || detailsData.items.length === 0) {
            return res.status(200).json({ error: "No video details found" });
        }

        const firstVideo = detailsData.items[0];

        return res.status(200).json({
            videoId: firstVideo.id,
            duration: firstVideo.contentDetails?.duration || null
        });

    } catch (error) {
        return res.status(500).json({
            error: "Server error",
            details: error.message
        });
    }
}