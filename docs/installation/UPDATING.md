# Update Vane to the latest version

## Docker (compose)

From your project directory:

```bash
git pull
docker compose up -d --build
```

## Docker (manual build)

```bash
git pull
docker build -t vane .
docker stop vane
docker rm vane
docker run -d -p 3000:3000 -v vane-data:/home/vane/data --name vane vane
```

Open http://localhost:3000 to verify. Settings in the `vane-data` volume are preserved.

## Non-Docker

```bash
git pull
npm i
npm run build
npm run start
```

Open http://localhost:3000 to verify. Local settings are preserved.
