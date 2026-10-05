// Homepage is now the TV player (public/index.html + tv.js).
// Keep this file so old caches don't 404.
location.replace("/" + location.search + location.hash);
