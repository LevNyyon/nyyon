# Blog publishing — external endpoints

The four endpoints the publish pipeline talks to. Each step stays OFF until its
key is configured — an empty value here behaves exactly like the unset
environment variable did before the plugin conversion.

- `prod_api_url` — production API base for the dev→prod mirror PUT.
- `blog_edge_url` — the blog-edge worker's direct URL, used to verify a post is
  actually live before success is reported.
- `public_origin` — the public site origin used in reported and announced URLs.
- `indexnow_key` — IndexNow key for search-engine pings.

To configure, add plain KEY=value lines (or a pure JSON object) to this doc.
The examples below are commented out with a leading # so they stay inert:

#prod_api_url=https://api.example.com
#blog_edge_url=https://blog-edge.example.workers.dev
#public_origin=https://www.example.com
#indexnow_key=0000000000000000000000000000000
