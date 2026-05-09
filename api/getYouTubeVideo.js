export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    let body;

    try {
        body =
            typeof req.body === "string"
                ? JSON.parse(req.body)
                : req.body;
    } catch {
        return res.status(400).json({ error: "Invalid JSON body" });
    }

    const query = body?.query;

    if (!query) {
        return res.status(400).json({ error: "Missing query" });
    }

    try {
        const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

        const searches = [
            query + " song",
            query + " official audio",
            query + " music video",
            query + " lyrics"
        ];
        for (const searchTerm of searches) {

            const response = await fetch(
                `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(searchTerm)}&key=${YOUTUBE_API_KEY}&maxResults=5&type=video`
            );

            const data = await response.json();

            console.log("YOUTUBE SEARCH TERM:", searchTerm);
            console.log("YOUTUBE RESPONSE:", data);

            if (data.error) {
                return res.status(200).json({
                    error: "YouTube API error",
                    details: data.error
                });
            }

            if (data.items && data.items.length > 0) {

                const validVideo = data.items.find(item =>
                    item.id?.videoId &&
                    !item.snippet.channelTitle.toLowerCase().includes("vevo") &&
                    !item.snippet.title.toLowerCase().includes("live") &&
                    !item.snippet.title.toLowerCase().includes("shorts") &&
                    !item.snippet.title.toLowerCase().includes("reaction")
                );

                if (validVideo) {
                    return res.status(200).json({
                        videoId: validVideo.id.videoId,
                        duration: null
                    });
                }
            }
        }

        return res.status(200).json({
            error: "No video found"
        });

    } catch (error) {

        return res.status(500).json({
            error: "Server error",
            details: error.message
        });
    }
}