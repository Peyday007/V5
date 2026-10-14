package tutor.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import forge.StaticData;
import forge.card.CardDb;
import forge.deck.Deck;
import forge.deck.DeckFormat;
import forge.deck.DeckSection;
import forge.game.GameType;
import forge.game.player.RegisteredPlayer;
import forge.gamemodes.match.HostedMatch;
import forge.gui.GuiBase;
import forge.item.PaperCard;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.player.GamePlayerUtil;
import forge.util.BuildInfo;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;

/**
 * Local HTTP front for one Forge engine. Binds to 127.0.0.1 only: it is the tutor server's
 * private adapter, not a public API.
 *
 * <pre>
 *   GET  /health
 *   POST /cards/check          {cards:[{name,set,number}]}
 *   POST /decks/validate       {deck}
 *   POST /matches              {human:{name,deck}, opponents:[{name,deck}]}
 *   GET  /matches/{id}/state?after=REV&amp;wait=MS
 *   POST /matches/{id}/act     {revision, action:{id, values?, amounts?, text?}}
 *   POST /matches/{id}/automation
 *   GET  /matches/{id}/history
 *   POST /matches/{id}/concede
 * </pre>
 */
public final class BridgeServer {
    private static final Gson GSON = new Gson();
    private static TutorGui gui;
    private static final Map<String, MatchSession> matches = new HashMap<>();
    private static String forgeRevision = "unknown";

    public static void main(String[] args) throws Exception {
        String assets = System.getProperty("forge.assets", System.getenv().getOrDefault("FORGE_ASSETS_DIR", "forge-gui/"));
        int port = Integer.parseInt(System.getenv().getOrDefault("FORGE_BRIDGE_PORT", "8765"));
        forgeRevision = System.getenv().getOrDefault("FORGE_REVISION", "unknown");
        long t0 = System.currentTimeMillis();
        gui = new TutorGui(assets);
        GuiBase.setInterface(gui);
        FModel.initialize(null, prefs -> {
            prefs.setPref(FPref.LOAD_CARD_SCRIPTS_LAZILY, false);
            prefs.setPref(FPref.UI_LANGUAGE, "en-US");
            prefs.setPref(FPref.ENFORCE_DECK_LEGALITY, false);
            prefs.setPref(FPref.PLAYER_NAME, "You");
            prefs.setPref(FPref.UI_ENABLE_AI_CHEATS, false);
            return null;
        });
        System.out.println("[bridge] Forge " + BuildInfo.getVersionString() + " initialized in " + (System.currentTimeMillis() - t0) + " ms; "
                + StaticData.instance().getCommonCards().getUniqueCards().size() + " cards");

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/", BridgeServer::handle);
        server.start();
        System.out.println("[bridge] listening on 127.0.0.1:" + port);
    }

    private static void handle(HttpExchange ex) throws IOException {
        try {
            String path = ex.getRequestURI().getPath();
            String method = ex.getRequestMethod();
            JsonObject body = "POST".equals(method) ? readBody(ex) : new JsonObject();
            Map<String, String> q = query(ex.getRequestURI());
            String[] seg = path.replaceAll("^/+|/+$", "").split("/");
            JsonElement out;
            if (path.equals("/health")) out = health();
            else if (path.equals("/cards/check")) out = checkCards(body.getAsJsonArray("cards"));
            else if (path.equals("/decks/validate")) out = validateDeck(body.getAsJsonObject("deck"));
            else if (path.equals("/matches") && method.equals("POST")) out = createMatch(body);
            else if (seg.length == 3 && seg[0].equals("matches")) {
                MatchSession m;
                synchronized (matches) { m = matches.get(seg[1]); }
                if (m == null) { send(ex, 404, error("No such match.")); return; }
                switch (seg[2]) {
                    case "state" -> out = m.state(Long.parseLong(q.getOrDefault("after", "-1")), Long.parseLong(q.getOrDefault("wait", "0")));
                    case "act" -> {
                        String err = m.act(body.get("revision").getAsLong(), body.getAsJsonObject("action"));
                        JsonObject r = new JsonObject();
                        r.addProperty("ok", err == null);
                        if (err != null) r.addProperty("error", err);
                        send(ex, err == null ? 200 : 409, r);
                        return;
                    }
                    case "automation" -> { m.setAutomation(body); out = m.automation(); }
                    case "history" -> out = m.history();
                    case "concede" -> { m.concede(); out = ok(); }
                    default -> { send(ex, 404, error("Unknown endpoint.")); return; }
                }
            } else { send(ex, 404, error("Unknown endpoint.")); return; }
            send(ex, 200, out);
        } catch (IllegalArgumentException e) {
            send(ex, 400, error(e.getMessage()));
        } catch (Throwable t) {
            t.printStackTrace();
            send(ex, 500, error(t.toString()));
        }
    }

    private static JsonObject health() {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        o.addProperty("engine", "Forge");
        o.addProperty("forgeVersion", BuildInfo.getVersionString());
        o.addProperty("forgeRevision", forgeRevision);
        o.addProperty("uniqueCards", StaticData.instance().getCommonCards().getUniqueCards().size());
        o.addProperty("multiplayer", true);
        return o;
    }

    // ------------------------------------------------------------ cards

    private static JsonArray checkCards(JsonArray cards) {
        CardDb db = StaticData.instance().getCommonCards();
        JsonArray out = new JsonArray();
        for (JsonElement e : cards) {
            JsonObject c = e.getAsJsonObject();
            String name = c.get("name").getAsString();
            String set = c.has("set") && !c.get("set").isJsonNull() ? c.get("set").getAsString() : null;
            String num = c.has("number") && !c.get("number").isJsonNull() ? c.get("number").getAsString() : null;
            JsonObject r = new JsonObject();
            r.addProperty("name", name);
            PaperCard pc = lookup(db, name);
            r.addProperty("supported", pc != null);
            if (pc != null) {
                r.addProperty("forgeName", pc.getName());
                PaperCard exact = set == null ? null : (num != null ? db.getCard(name, set, num) : db.getCard(name, set));
                r.addProperty("printingFound", exact != null);
                r.addProperty("aiPlayable", !pc.getRules().getAiHints().getRemAIDecks());
            } else {
                r.addProperty("reason", "This Forge build has no script for \"" + name + "\".");
            }
            out.add(r);
        }
        return out;
    }

    /**
     * Forge names split cards "A // B" but adventure, transform, flip and modal double-faced cards
     * by their front face. Scryfall names all of them "A // B", so the front face is the fallback.
     */
    static PaperCard lookup(CardDb db, String name) {
        PaperCard pc = db.getCard(name);
        if (pc == null && name.contains(" // ")) pc = db.getCard(name.substring(0, name.indexOf(" // ")));
        return pc;
    }

    static Deck buildDeck(JsonObject d) {
        CardDb db = StaticData.instance().getCommonCards();
        Deck deck = new Deck(d.has("name") ? d.get("name").getAsString() : "Deck");
        List<String> missing = new ArrayList<>();
        addSection(db, deck, DeckSection.Commander, d.getAsJsonArray("commander"), missing);
        addSection(db, deck, DeckSection.Main, d.getAsJsonArray("main"), missing);
        if (!missing.isEmpty()) throw new IllegalArgumentException("Forge cannot load: " + String.join(", ", missing));
        return deck;
    }

    private static void addSection(CardDb db, Deck deck, DeckSection section, JsonArray cards, List<String> missing) {
        if (cards == null) return;
        for (JsonElement e : cards) {
            JsonObject c = e.getAsJsonObject();
            String name = c.get("name").getAsString();
            int count = c.has("count") ? c.get("count").getAsInt() : 1;
            String set = c.has("set") && !c.get("set").isJsonNull() ? c.get("set").getAsString() : null;
            String num = c.has("number") && !c.get("number").isJsonNull() ? c.get("number").getAsString() : null;
            PaperCard pc = null;
            String front = name.contains(" // ") ? name.substring(0, name.indexOf(" // ")) : name;
            if (set != null && num != null) pc = db.getCard(name, set, num);
            if (pc == null && set != null && num != null) pc = db.getCard(front, set, num);
            if (pc == null && set != null) pc = db.getCard(name, set);
            if (pc == null && set != null) pc = db.getCard(front, set);
            if (pc == null) pc = lookup(db, name);
            if (pc == null) { missing.add(name); continue; }
            deck.getOrCreate(section).add(pc, count);
        }
    }

    private static JsonObject validateDeck(JsonObject d) {
        JsonObject o = new JsonObject();
        try {
            Deck deck = buildDeck(d);
            String problem = DeckFormat.Commander.getDeckConformanceProblem(deck);
            o.addProperty("conforms", problem == null);
            if (problem != null) o.addProperty("problem", problem);
            o.addProperty("mainCount", deck.getMain().countAll());
            o.addProperty("commanderCount", deck.get(DeckSection.Commander) == null ? 0 : deck.get(DeckSection.Commander).countAll());
        } catch (IllegalArgumentException e) {
            o.addProperty("conforms", false);
            o.addProperty("problem", e.getMessage());
        }
        return o;
    }

    // ------------------------------------------------------------ matches

    private static JsonObject createMatch(JsonObject body) {
        JsonObject humanSpec = body.getAsJsonObject("human");
        JsonArray opps = body.getAsJsonArray("opponents");
        if (opps == null || opps.isEmpty() || opps.size() > 3) throw new IllegalArgumentException("Between one and three AI opponents are supported.");
        Deck humanDeck = buildDeck(humanSpec.getAsJsonObject("deck"));
        List<RegisteredPlayer> players = new ArrayList<>();
        RegisteredPlayer human = RegisteredPlayer.forCommander(humanDeck);
        human.setPlayer(GamePlayerUtil.getGuiPlayer());
        players.add(human);
        for (JsonElement e : opps) {
            JsonObject o = e.getAsJsonObject();
            RegisteredPlayer ai = RegisteredPlayer.forCommander(buildDeck(o.getAsJsonObject("deck")));
            ai.setPlayer(GamePlayerUtil.createAiPlayer(o.has("name") ? o.get("name").getAsString() : "AI"));
            players.add(ai);
        }
        synchronized (matches) {
            for (MatchSession old : matches.values()) {
                try { old.concede(); } catch (Exception ignored) { }
            }
            matches.clear();
        }
        String id = UUID.randomUUID().toString();
        HostedMatch hosted = gui.hostMatch();
        BridgeGuiGame bg = new BridgeGuiGame(null);
        MatchSession session = new MatchSession(id, hosted, bg, gui);
        bg.attach(session);
        synchronized (matches) { matches.put(id, session); }
        // Test scenarios only: Forge's own game-state setup (the format of its puzzle files and of
        // its developer "Setup Game State" command), applied at game start exactly as Forge's
        // puzzle mode does. Refused unless the bridge was started with TUTOR_BRIDGE_SCENARIOS=1,
        // so an ordinary practice game can never be given a hand-made position.
        if (body.has("scenario")) {
            if (!"1".equals(System.getenv("TUTOR_BRIDGE_SCENARIOS"))) throw new IllegalArgumentException("Scenarios are only accepted when the bridge runs with TUTOR_BRIDGE_SCENARIOS=1.");
            java.util.List<String> lines = new java.util.ArrayList<>();
            for (var l : body.getAsJsonArray("scenario")) lines.add(l.getAsString());
            forge.game.GameState state = new forge.game.GameState();
            state.parse(lines);
            hosted.setStartGameHook(() -> state.applyToGame(hosted.getGame()));
        }
        // The applied variant is what turns on the Commander-only rules inside Forge's engine: the
        // command-zone choice when a commander is put into a graveyard or exile (CR 903.9a) and the
        // loss at 21 commander damage (CR 704.6c). Passing no variants plays the game without them.
        hosted.startMatch(GameType.Commander, java.util.EnumSet.of(GameType.Commander), players, human, bg);
        JsonObject o = new JsonObject();
        o.addProperty("matchId", id);
        o.addProperty("players", players.size());
        o.addProperty("gameType", GameType.Commander.name());
        return o;
    }

    // ------------------------------------------------------------ http plumbing

    private static JsonObject readBody(HttpExchange ex) throws IOException {
        try (InputStream in = ex.getRequestBody()) {
            String s = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            if (s.isBlank()) return new JsonObject();
            return JsonParser.parseString(s).getAsJsonObject();
        }
    }

    private static Map<String, String> query(URI uri) {
        Map<String, String> m = new HashMap<>();
        if (uri.getQuery() == null) return m;
        for (String kv : uri.getQuery().split("&")) {
            String[] p = kv.split("=", 2);
            m.put(p[0], p.length > 1 ? p[1] : "");
        }
        return m;
    }

    private static void send(HttpExchange ex, int status, JsonElement body) throws IOException {
        byte[] bytes = GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    private static JsonObject error(String m) { JsonObject o = new JsonObject(); o.addProperty("error", m); return o; }
    private static JsonObject ok() { JsonObject o = new JsonObject(); o.addProperty("ok", true); return o; }
}
