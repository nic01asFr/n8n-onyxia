// Point d'entrée du conteneur « portal ». Séparé de server.mjs pour que les
// tests importent le serveur sans le démarrer.
import { main } from "./server.mjs";

await main();
