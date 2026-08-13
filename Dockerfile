# Ciné-Fil serves its own files and has no runtime dependency, so there is nothing to install and nothing to
# build: the image is the source tree plus a Node runtime. Works as-is on Cloud Run, Railway, Koyeb, Fly and
# anything else that speaks containers.
FROM node:24-alpine

WORKDIR /app
COPY . .

# Hosts inject their own port; the server already honours it and listens on every interface.
ENV PORT=8080
EXPOSE 8080

# TMDB_API_TOKEN is optional. Without it the Wikidata and Wikipédia verification still runs and filmographies
# are served from the published overlay; with it, artists absent from the local snapshot become searchable.
CMD ["node", "server.mjs"]
