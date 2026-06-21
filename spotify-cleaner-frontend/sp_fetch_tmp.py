import json, urllib.parse, urllib.request

token = open("/tmp/sp_token.txt").read().strip()

queries = [
    (2016, "One Dance", "Drake"),
    (2017, "Shape of You", "Ed Sheeran"),
    (2018, "God's Plan", "Drake"),
    (2019, "Old Town Road", "Lil Nas X"),
    (2020, "Blinding Lights", "The Weeknd"),
    (2021, "drivers license", "Olivia Rodrigo"),
    (2022, "As It Was", "Harry Styles"),
    (2023, "Flowers", "Miley Cyrus"),
    (2024, "Espresso", "Sabrina Carpenter"),
    (2025, "APT.", "ROSE Bruno Mars"),
    (2026, "Die With a Smile", "Lady Gaga Bruno Mars"),
]

def search(title, artist):
    q = f'track:{title} artist:{artist}'
    url = "https://api.spotify.com/v1/search?" + urllib.parse.urlencode({"q": q, "type": "track", "limit": "5", "market": "US"})
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as r:
        data = json.load(r)
    return data.get("tracks", {}).get("items", [])

results = []
for year, title, artist in queries:
    items = search(title, artist)
    pick = items[0] if items else None
    if pick:
        imgs = pick["album"]["images"]
        art = imgs[0]["url"] if imgs else None
        results.append({
            "year": year, "title": title, "artist": artist,
            "spotify_name": pick["name"],
            "spotify_artist": ", ".join(a["name"] for a in pick["artists"]),
            "id": pick["id"], "albumArt": art, "preview_url": pick.get("preview_url"),
        })
    else:
        results.append({"year": year, "title": title, "artist": artist, "id": None, "albumArt": None, "preview_url": None})

print(json.dumps(results, indent=2))
