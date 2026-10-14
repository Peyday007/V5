package tutor.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.ai.ComputerUtilAbility;
import forge.ai.ComputerUtilMana;
import forge.ai.PlayerControllerAi;
import forge.card.mana.ManaAtom;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.GameEntityView;
import forge.game.GameLogEntry;
import forge.game.card.Card;
import forge.game.card.CardView;
import forge.game.card.CounterType;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.phase.PhaseHandler;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.spellability.SpellAbilityView;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.HostedMatch;
import forge.gamemodes.match.input.Input;
import forge.gamemodes.match.input.InputAttack;
import forge.gamemodes.match.input.InputBlock;
import forge.gamemodes.match.input.InputPassPriority;
import forge.gamemodes.match.input.InputPayMana;
import forge.interfaces.IGameController;
import forge.player.PlayerControllerHuman;

import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * One match, seen from the human's seat.
 *
 * <p>Forge runs the game on its own thread. When it needs the human it either sets an
 * {@link Input} and blocks in {@link #awaitInput}, or calls a {@link BridgeGuiGame} dialog that
 * blocks in {@link #ask}. Either way the game is paused, so that is the only moment this class
 * reads game state: each pause publishes a new {@link #revision} with a viewer-safe snapshot and
 * the closed set of actions Forge would accept. An action is applied only against the revision
 * it names; a stale one is refused, never re-targeted.
 */
final class MatchSession {
    final String id;
    final HostedMatch match;
    final BridgeGuiGame gui;
    final TutorGui tutorGui;
    private final Object lock = new Object();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "tutor-publish"); t.setDaemon(true); return t;
    });

    private long revision = 0;
    private long published = 0;
    /** The first revision at which the current decision was shown; any revision since then shows the same choice. */
    private long decisionSince = 0;
    /** The input decision most recently answered, and when: Forge may take a moment to act on a
     *  click, and until it does the same input still looks open. Re-offering it then would show
     *  the player a choice they have already made. */
    private Decision answered;
    private long answeredAt;
    private static final long ANSWER_SETTLE_MS = 1500;
    /** No publish of a freshly opened input before this time (see awaitInput). */
    private long settleUntil = 0;
    private JsonObject snapshot = new JsonObject();
    private Decision current;
    private CountDownLatch inputLatch;
    private final Deque<DialogWait> dialogs = new ArrayDeque<>();
    private ScheduledFuture<?> pendingRepublish;
    private volatile boolean actionInFlight;
    private boolean over;
    private final List<String> notices = new ArrayList<>();
    private final List<JsonObject> history = new ArrayList<>();
    private final Set<PhaseType> stopsMyTurn = EnumSet.of(PhaseType.MAIN1, PhaseType.COMBAT_DECLARE_ATTACKERS, PhaseType.MAIN2);
    private final Set<PhaseType> stopsTheirTurn = EnumSet.of(PhaseType.COMBAT_DECLARE_BLOCKERS, PhaseType.END_OF_TURN);
    private volatile boolean autoPassNoResponses = true;
    private int logCursor = 0;
    private final List<String> log = new ArrayList<>();

    private static final class DialogWait {
        final Decision decision;
        final CompletableFuture<JsonObject> answer = new CompletableFuture<>();
        DialogWait(Decision d) { decision = d; }
    }

    MatchSession(String id, HostedMatch match, BridgeGuiGame gui, TutorGui tutorGui) {
        this.id = id;
        this.match = match;
        this.gui = gui;
        this.tutorGui = tutorGui;
    }

    Game game() { return match.getGame(); }

    Player human() {
        Game g = game();
        if (g == null) return null;
        for (Player p : g.getPlayers()) if (p.getController() instanceof PlayerControllerHuman) return p;
        for (Player p : g.getRegisteredPlayers()) if (p.getController() instanceof PlayerControllerHuman) return p;
        return null;
    }

    private IGameController controller() {
        Player h = human();
        return h == null ? null : gui.getGameController(h.getView());
    }

    // ================================================================ Forge -> tutor

    /** Game thread: an Input has been set and Forge is about to wait for it. */
    void awaitInput(CountDownLatch done) throws InterruptedException {
        tutorGui.flushUi(); // let the input draw its prompt and buttons first
        synchronized (lock) {
            inputLatch = done;
        }
        // Forge sometimes opens an input and withdraws it a few milliseconds later without any
        // click (a priority stop it then skips, a target prompt it redraws). Offering it would show
        // the player a choice that is about to vanish, so a new input is published only if it is
        // still waiting after a short settle.
        synchronized (lock) { settleUntil = System.currentTimeMillis() + 150; }
        if (!autoPass()) schedulePublish(150);
        try {
            done.await();
        } finally {
            synchronized (lock) {
                if (inputLatch == done) inputLatch = null;
            }
        }
    }

    /** Any thread: Forge asks a question; blocks until the tutor answers it. */
    JsonObject ask(Decision d) {
        DialogWait w = new DialogWait(d);
        synchronized (lock) { dialogs.push(w); }
        publish();
        try {
            return w.answer.get();
        } catch (Exception e) {
            throw new RuntimeException(e);
        } finally {
            synchronized (lock) { dialogs.remove(w); }
            schedulePublish(30);
        }
    }

    /** An input redrew itself (cost partly paid, attacker toggled, ...). */
    void inputChanged() {
        synchronized (lock) {
            if (inputLatch == null) return;
        }
        schedulePublish(60);
    }

    private void schedulePublish(long delayMs) {
        synchronized (lock) {
            delayMs = Math.max(delayMs, settleUntil - System.currentTimeMillis());
            if (pendingRepublish != null) pendingRepublish.cancel(false);
            pendingRepublish = scheduler.schedule(() -> {
                boolean waiting;
                synchronized (lock) {
                    waiting = !dialogs.isEmpty() || (inputLatch != null && inputLatch.getCount() > 0);
                }
                if (waiting && !actionInFlight) publish();
                else if (!waiting) publishBusy();
            }, delayMs, TimeUnit.MILLISECONDS);
        }
    }

    void notice(String text) {
        synchronized (lock) { notices.add(text); }
    }

    void gameEnded() {
        synchronized (lock) {
            if (over) return;
            over = true;
        }
        publish();
    }

    boolean skipPhase(PlayerView turn, PhaseType phase) {
        Player h = human();
        boolean mine = h != null && turn != null && turn.getId() == h.getId();
        return !(mine ? stopsMyTurn : stopsTheirTurn).contains(phase);
    }

    // ================================================================ tutor -> Forge

    /**
     * Applies one action if it names the current revision and an action id offered for it.
     * Returns null on success, else the reason it was refused (nothing changed).
     */
    String act(long rev, JsonObject action) {
        Decision d;
        DialogWait w;
        synchronized (lock) {
            if (over) return "The game is over.";
            d = current;
            w = dialogs.peek();
            if (d == null) return "Forge is not waiting for you right now.";
            // A redraw that only refreshed the log or the board keeps the same choice open, so an
            // answer from any revision since this decision appeared still answers it.
            if (rev < decisionSince || rev > revision) return "That action was for an earlier position (revision " + rev + "; this decision has been open since " + decisionSince + "). Nothing was changed.";
        }
        String id = action.has("id") ? action.get("id").getAsString() : "";
        if (!d.actionIds.contains(id)) return "\"" + id + "\" is not one of the legal actions for this decision.";
        record("ACTION", id, action);
        if ("dialog".equals(d.kind)) {
            if (d.handler != null && d.actionIds.size() > 0 && !id.equals("cancel") && !id.equals("none") && !id.startsWith("opt:")) {
                String err = d.handler.apply(action);
                if (err != null) return err;
            }
            synchronized (lock) { current = null; revision++; }
            w.answer.complete(action);
            return null;
        }
        // An input: feed it the way a click would, on the UI thread.
        IGameController c = controller();
        if (c == null) return "No human controller is attached.";
        Player me = human();
        String[] parts = id.split(":");
        actionInFlight = true;
        final boolean[] accepted = {true};
        synchronized (lock) { current = null; revision++; answered = d; answeredAt = System.currentTimeMillis(); }
        try {
            tutorGui.runOnUi(() -> {
                switch (parts[0]) {
                    case "ok" -> c.selectButtonOk();
                    case "cancel" -> c.selectButtonCancel();
                    case "alpha" -> c.alphaStrike();
                    case "card" -> {
                        Card card = game().findById(Integer.parseInt(parts[1]));
                        if (card != null) accepted[0] = c.selectCard(card.getView(), null, null);
                    }
                    case "player" -> {
                        Player p = findPlayer(Integer.parseInt(parts[1]));
                        if (p != null) c.selectPlayer(p.getView(), null);
                    }
                    case "mana" -> c.useMana(Byte.parseByte(parts[1]));
                    case "play" -> {
                        SpellAbility sa = (SpellAbility) d.abilities.get(id);
                        if (sa != null) accepted[0] = ((PlayerControllerHuman) me.getController()).getInputProxy().selectAbility(sa);
                    }
                    default -> { }
                }
            });
        } finally {
            actionInFlight = false;
        }
        schedulePublish(80);
        if (!accepted[0]) {
            synchronized (lock) { answered = null; }
            notice("Forge did not accept \"" + id + "\" in this position.");
            return "Forge did not accept that action in this position. Nothing changed.";
        }
        return null;
    }

    void setAutomation(JsonObject o) {
        if (o.has("autoPassNoResponses")) autoPassNoResponses = o.get("autoPassNoResponses").getAsBoolean();
        if (o.has("stopsMyTurn")) replace(stopsMyTurn, o.getAsJsonArray("stopsMyTurn"));
        if (o.has("stopsTheirTurn")) replace(stopsTheirTurn, o.getAsJsonArray("stopsTheirTurn"));
    }

    JsonObject automation() {
        JsonObject o = new JsonObject();
        o.addProperty("autoPassNoResponses", autoPassNoResponses);
        o.add("stopsMyTurn", names(stopsMyTurn));
        o.add("stopsTheirTurn", names(stopsTheirTurn));
        return o;
    }

    private static void replace(Set<PhaseType> set, JsonArray arr) {
        set.clear();
        for (var e : arr) {
            try { set.add(PhaseType.valueOf(e.getAsString())); } catch (IllegalArgumentException ignored) { }
        }
    }

    private static JsonArray names(Set<PhaseType> set) {
        JsonArray a = new JsonArray();
        for (PhaseType p : set) a.add(p.name());
        return a;
    }

    void concede() {
        IGameController c = controller();
        if (c != null) tutorGui.runOnUi(c::concede);
        synchronized (lock) {
            for (DialogWait w : dialogs) {
                JsonObject cancel = new JsonObject();
                cancel.addProperty("id", "cancel");
                w.answer.complete(cancel);
            }
        }
    }

    /** Waits up to {@code waitMs} for a revision newer than {@code after}, then returns the state. */
    JsonObject state(long after, long waitMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + waitMs;
        synchronized (lock) {
            while (published <= Math.max(after, 0) && !over) {
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) break;
                lock.wait(left);
            }
            return snapshot.deepCopy();
        }
    }

    JsonArray history() {
        synchronized (lock) {
            JsonArray a = new JsonArray();
            history.forEach(a::add);
            return a;
        }
    }

    // ================================================================ publishing

    private void publish() {
        JsonObject snap;
        Decision d;
        synchronized (lock) {
            DialogWait w = dialogs.peek();
            if (w != null) d = w.decision;
            else if (inputLatch != null && inputLatch.getCount() > 0) d = buildInputDecision();
            else d = null;
        }
        try {
            snap = buildState(d);
        } catch (Exception e) {
            e.printStackTrace();
            snap = new JsonObject();
            snap.addProperty("error", "Could not read the game state: " + e);
        }
        synchronized (lock) {
            if (d != null && answered != null && d.origin != null && d.origin == answered.origin
                    && sameActions(d, answered) && d.view.get("prompt").equals(answered.view.get("prompt"))) {
                if (System.currentTimeMillis() - answeredAt < ANSWER_SETTLE_MS) {
                    schedulePublish(120); // Forge has not acted on the click yet; look again shortly
                    return;
                }
            }
            if (d != null && d != answered) answered = null;
            // A redraw that changed nothing the player can see keeps its revision, so an answer
            // already in flight for it is not refused as stale.
            JsonObject prev = snapshot.deepCopy();
            prev.remove("revision"); prev.remove("status");
            if (d != null && current != null && prev.equals(snap) && sameActions(current, d) && published == revision) {
                current = d;
                return;
            }
            boolean same = d != null && current != null && sameDecision(current, d);
            revision++;
            if (!same) decisionSince = revision;
            current = d;
            snap.addProperty("revision", revision);
            if (d != null) snap.addProperty("decisionSince", decisionSince);
            published = revision;
            snap.addProperty("status", over ? "over" : d != null ? "waiting" : "busy");
            snapshot = snap;
            if (d != null && !same) record("DECISION", d.view.get("type").getAsString(), d.view);
            lock.notifyAll();
        }
    }

    private static boolean sameDecision(Decision a, Decision b) {
        if ("dialog".equals(a.kind) || "dialog".equals(b.kind)) return a == b;
        // The prompt text is not part of the identity: Forge may first draw a priority prompt
        // with the previous phase's wording and correct it a moment later on the same input.
        return a.origin != null && a.origin == b.origin && sameActions(a, b);
    }

    private static boolean sameActions(Decision a, Decision b) {
        return a.kind.equals(b.kind) && a.actionIds.equals(b.actionIds);
    }

    private void publishBusy() {
        synchronized (lock) {
            if (current == null && !over && snapshot.has("status") && "busy".equals(snapshot.get("status").getAsString())) return;
        }
        publish();
    }

    /**
     * Passes priority without showing the decision, only when the stack is non-empty and Forge's
     * own checks find nothing the player could afford to respond with. Returns true if it passed.
     */
    private boolean autoPass() {
        if (!autoPassNoResponses) return false;
        Game g = game();
        if (g == null || g.getStack().isEmpty()) return false;
        Decision d;
        synchronized (lock) { d = buildInputDecision(); }
        if (!"PassPriority".equals(d.view.get("type").getAsString())) return false;
        if (d.view.get("responses").getAsInt() > 0) return false;
        SpellAbilityStackInstance top = g.getStack().peek();
        notice("Auto-passed: you had no affordable response to "
                + (top == null || top.getSourceCard() == null ? "the stack" : top.getSourceCard().getName())
                + ". (You can turn this off in the automation settings.)");
        JsonObject e = new JsonObject();
        e.addProperty("stack", top == null ? "" : top.getStackDescription());
        record("AUTO_PASS", "ok", e);
        IGameController c = controller();
        tutorGui.invokeInEdtLater(c::selectButtonOk);
        return true;
    }

    private void record(String kind, String what, JsonObject detail) {
        JsonObject e = new JsonObject();
        e.addProperty("kind", kind);
        e.addProperty("what", what);
        e.addProperty("revision", revision);
        Game g = game();
        if (g != null) {
            e.addProperty("turn", g.getPhaseHandler().getTurn());
            PhaseType ph = g.getPhaseHandler().getPhase();
            e.addProperty("phase", ph == null ? "" : ph.name());
        }
        e.add("detail", detail.deepCopy());
        history.add(e);
    }

    // ================================================================ decisions from inputs

    private Decision buildInputDecision() {
        Player me = human();
        PlayerControllerHuman pch = (PlayerControllerHuman) me.getController();
        Input input = pch.getInputQueue().getInput();
        String type = input == null ? "Input" : input.getClass().getSimpleName().replaceFirst("^Input", "");
        Decision d = new Decision("input", type, gui.promptMessage());
        // One latch per wait for the player, so it identifies the decision even before Forge's
        // input queue shows the new input.
        d.origin = inputLatch;
        if (gui.okEnabled()) d.action("ok", gui.okLabel(), "button");
        if (gui.cancelEnabled()) d.action("cancel", gui.cancelLabel(), "button");
        Game g = game();

        if (input instanceof InputPassPriority) {
            int responses = 0;
            JsonArray playables = new JsonArray();
            for (Card c : candidateCards(me)) {
                for (SpellAbility sa : c.getAllPossibleAbilities(me, true)) {
                    if (sa.isManaAbility()) continue;
                    boolean affordable = canAfford(sa, me);
                    boolean targetable = withAi(me, () -> ComputerUtilAbility.isFullyTargetable(sa));
                    String kind = sa.isLandAbility() ? "land" : sa.isSpell() ? "spell" : "ability";
                    String label = (kind.equals("land") ? "Play " : kind.equals("spell") ? "Cast " : "Activate ") + c.getName()
                            + (kind.equals("ability") ? ": " + safe(sa.toString()) : "");
                    String aid = "play:" + c.getId() + ":" + sa.getId();
                    d.abilities.put(aid, sa);
                    JsonObject a = d.action(aid, label, kind);
                    a.addProperty("cardId", c.getId());
                    a.addProperty("affordable", affordable);
                    a.addProperty("hasTargets", targetable);
                    a.addProperty("cost", sa.getPayCosts() == null ? "" : safe(sa.getPayCosts().toSimpleString()));
                    a.addProperty("text", safe(sa.getDescription()));
                    a.addProperty("zone", String.valueOf(c.getZone() == null ? "" : c.getZone().getZoneType()));
                    if (affordable && targetable) responses++;
                    playables.add(a);
                }
            }
            d.view.addProperty("responses", responses);
            d.view.add("diagnoses", diagnose(me));
            relabelPass(d, g);
        } else if (input instanceof InputAttack) {
            for (Card c : me.getCreaturesInPlay()) {
                if (CombatUtil.canAttack(c)) d.action("card:" + c.getId(), "Toggle attack: " + c.getName(), "attacker").addProperty("cardId", c.getId());
            }
            Combat combat = g.getCombat();
            if (combat != null) {
                for (GameEntity def : combat.getDefenders()) {
                    if (def instanceof Player p) d.action("player:" + p.getId(), "Attack " + p.getName(), "defender").addProperty("playerId", p.getId());
                    else if (def instanceof Card c) d.action("card:" + c.getId(), "Attack " + c.getName(), "defender").addProperty("cardId", c.getId());
                }
            }
            d.action("alpha", "Attack with everything that can", "button");
        } else if (input instanceof InputBlock) {
            Combat combat = g.getCombat();
            if (combat != null) {
                for (Card a : combat.getAttackers()) d.action("card:" + a.getId(), "Choose attacker to block: " + a.getName(), "attacker").addProperty("cardId", a.getId());
                for (Card c : me.getCreaturesInPlay()) {
                    if (CombatUtil.canBlock(c, combat)) d.action("card:" + c.getId(), "Block with " + c.getName(), "blocker").addProperty("cardId", c.getId());
                }
            }
        } else {
            boolean any = false;
            JsonArray offered = new JsonArray();
            for (CardView v : gui.selectableCards()) {
                Card c = g.findById(v.getId());
                if (c == null || d.actionIds.contains("card:" + c.getId())) continue;
                any = true;
                String cat = input instanceof InputPayMana ? "manaSource" : "select";
                d.action("card:" + c.getId(), (input instanceof InputPayMana ? "Tap for mana: " : "Select ") + describe(v, null), cat).addProperty("cardId", c.getId());
                // A card offered from a hidden zone (a library you were allowed to look at) is described here.
                JsonObject cj = cardJson(c, me.getView());
                if (Boolean.TRUE.equals(cj.has("hidden") && cj.get("hidden").getAsBoolean()) && (v.mayPlayerLook(me.getView()))) {
                    cj = cardJsonForced(c, me.getView());
                }
                offered.add(cj);
            }
            d.view.add("offeredCards", offered);
            d.view.addProperty("selectionMin", gui.getSelectionMin());
            d.view.addProperty("selectionMax", gui.getSelectionMax());
            for (Player p : g.getPlayers()) {
                if (gui.isSelectable(p.getView())) {
                    any = true;
                    d.action("player:" + p.getId(), "Select " + p.getName(), "select").addProperty("playerId", p.getId());
                }
            }
            if (input instanceof InputPayMana) {
                for (byte color : ManaAtom.MANATYPES) {
                    if (me.getManaPool().getAmountOfColor(color) > 0) {
                        d.action("mana:" + color, "Pay with floating " + colorName(color) + " mana", "manaPool");
                    }
                }
                for (Card c : me.getCardsIn(ZoneType.Battlefield)) {
                    String id = "card:" + c.getId();
                    if (d.actionIds.contains(id)) continue;
                    if (!c.getManaAbilities().isEmpty() && !c.isTapped()) {
                        d.action(id, "Tap for mana: " + c.getName(), "manaSource").addProperty("cardId", c.getId());
                    }
                }
            }
            boolean selecting = input != null && (input.getClass().getSimpleName().startsWith("InputSelect") || input.getClass().getSimpleName().equals("InputLondonMulligan"));
            if (!any && selecting) {
                // Forge set no explicit selectables: offer every card the human can see; Forge decides.
                for (Card c : allVisibleCards(me)) {
                    d.action("card:" + c.getId(), "Select " + describe(c.getView(), null), "select").addProperty("cardId", c.getId());
                }
                for (Player p : g.getPlayers()) d.action("player:" + p.getId(), "Select " + p.getName(), "select").addProperty("playerId", p.getId());
            }
            markChosen(d, input);
        }
        return d;
    }

    /**
     * In a multi-select (several targets, several cards), clicking a chosen option again
     * un-chooses it. Marks what is already chosen so the player can see it, and so the label says
     * what the click will do.
     */
    private static void markChosen(Decision d, Object input) {
        java.util.Set<String> chosen = new java.util.HashSet<>();
        try {
            if (input instanceof forge.gamemodes.match.input.InputSelectManyBase<?> many) {
                for (Object o : many.getSelected()) chosen.add(entityId(o));
            } else if (input instanceof forge.gamemodes.match.input.InputSelectTargets) {
                java.lang.reflect.Field f = input.getClass().getDeclaredField("sa");
                f.setAccessible(true);
                SpellAbility sa = (SpellAbility) f.get(input);
                if (sa != null && sa.getTargets() != null) for (Object o : sa.getTargets()) chosen.add(entityId(o));
            }
        } catch (Exception ignored) { return; }
        if (chosen.isEmpty()) return;
        for (var e : d.actions) {
            JsonObject a = e.getAsJsonObject();
            if (!chosen.contains(a.get("id").getAsString())) continue;
            a.addProperty("selected", true);
            a.addProperty("label", a.get("label").getAsString().replaceFirst("^Select ", "Deselect "));
        }
        d.view.addProperty("chosenCount", chosen.size());
    }

    private static String entityId(Object o) {
        if (o instanceof Card c) return "card:" + c.getId();
        if (o instanceof Player p) return "player:" + p.getId();
        return "";
    }

    private void relabelPass(Decision d, Game g) {
        for (var e : d.actions) {
            JsonObject a = e.getAsJsonObject();
            String id = a.get("id").getAsString();
            if (id.equals("ok")) {
                a.addProperty("label", g.getStack().isEmpty() ? "Pass priority (continue)" : "Pass priority (let the top of the stack resolve)");
            }
            if (id.equals("cancel") && a.get("label").getAsString().toLowerCase().contains("end")) {
                a.addProperty("label", "Pass until end of turn");
            }
        }
    }

    private List<Card> candidateCards(Player me) {
        List<Card> out = new ArrayList<>();
        for (ZoneType z : new ZoneType[]{ZoneType.Hand, ZoneType.Command, ZoneType.Battlefield, ZoneType.Flashback}) {
            for (Card c : me.getCardsIn(z)) if (!out.contains(c)) out.add(c);
        }
        for (Card c : me.getGame().getCardsIn(ZoneType.Exile)) {
            if (!out.contains(c) && c.mayPlay(me) != null && !c.mayPlay(me).isEmpty()) out.add(c);
        }
        return out;
    }

    private List<Card> allVisibleCards(Player me) {
        List<Card> out = new ArrayList<>();
        PlayerView pv = me.getView();
        for (Player p : game().getPlayers()) {
            for (ZoneType z : new ZoneType[]{ZoneType.Battlefield, ZoneType.Hand, ZoneType.Graveyard, ZoneType.Exile, ZoneType.Command}) {
                for (Card c : p.getCardsIn(z)) {
                    if (c.isImmutable()) continue;
                    if (z == ZoneType.Hand && p != me && !c.getView().canBeShownTo(pv)) continue;
                    out.add(c);
                }
            }
        }
        for (SpellAbilityStackInstance si : game().getStack()) {
            if (si.getSourceCard() != null && !out.contains(si.getSourceCard())) out.add(si.getSourceCard());
        }
        return out;
    }

    // ================================================================ "why can't I"

    private JsonArray diagnose(Player me) {
        JsonArray out = new JsonArray();
        Game g = game();
        PhaseHandler ph = g.getPhaseHandler();
        boolean myTurn = ph.getPlayerTurn() == me;
        for (ZoneType z : new ZoneType[]{ZoneType.Hand, ZoneType.Command, ZoneType.Battlefield}) {
            for (Card c : me.getCardsIn(z)) {
                List<SpellAbility> all = c.getAllPossibleAbilities(me, false);
                List<SpellAbility> playable = c.getAllPossibleAbilities(me, true);
                JsonObject o = new JsonObject();
                o.addProperty("cardId", c.getId());
                o.addProperty("name", c.getName());
                o.addProperty("zone", z.name());
                JsonArray reasons = new JsonArray();
                boolean canDoSomething = false;
                List<SpellAbility> considered = new ArrayList<>();
                for (SpellAbility sa : all) if (!sa.isManaAbility()) considered.add(sa);
                if (z == ZoneType.Hand && considered.isEmpty()) {
                    // getAllPossibleAbilities drops abilities that are impossible right now; fall back to the card's own spells.
                    for (SpellAbility sa : c.getSpellAbilities()) { sa.setActivatingPlayer(me); considered.add(sa); }
                }
                for (SpellAbility sa : considered) {
                    boolean canPlay = playable.contains(sa);
                    if (!canPlay) {
                        reasons.add(reason(sa, timingReason(sa, c, me, myTurn, ph, g), "canPlay"));
                        continue;
                    }
                    if (!canAfford(sa, me)) {
                        reasons.add(reason(sa, "Not enough mana: it costs " + safe(sa.getPayCosts().toSimpleString())
                                + " and Forge cannot find a way to pay that with your untapped mana sources and floating mana.", "mana"));
                        continue;
                    }
                    if (!withAi(me, () -> ComputerUtilAbility.isFullyTargetable(sa))) {
                        reasons.add(reason(sa, "There is no legal target for it right now.", "targets"));
                        continue;
                    }
                    canDoSomething = true;
                }
                if (z == ZoneType.Battlefield && considered.isEmpty()) continue;
                o.addProperty("playable", canDoSomething);
                o.add("reasons", reasons);
                out.add(o);
            }
        }
        return out;
    }

    private JsonObject reason(SpellAbility sa, String text, String check) {
        JsonObject r = new JsonObject();
        r.addProperty("ability", safe(sa.isSpell() ? "Cast " + sa.getHostCard().getName() : sa.isLandAbility() ? "Play " + sa.getHostCard().getName() : sa.toString()));
        r.addProperty("text", text);
        r.addProperty("engineCheck", check);
        return r;
    }

    private String timingReason(SpellAbility sa, Card c, Player me, boolean myTurn, PhaseHandler ph, Game g) {
        ZoneType zone = c.getZone() == null ? null : c.getZone().getZoneType();
        if (sa.isLandAbility()) {
            if (!myTurn) return "You can only play a land during your own turn.";
            if (!ph.isPlayerTurn(me) || !ph.getPhase().isMain()) return "You can only play a land during your main phase (it is " + phaseName(ph.getPhase()) + ").";
            if (!g.getStack().isEmpty()) return "You can only play a land while the stack is empty.";
            if (me.getLandsPlayedThisTurn() >= me.getMaxLandPlays()) return "You have already played " + me.getLandsPlayedThisTurn() + " land(s) this turn (your limit is " + me.getMaxLandPlays() + ").";
            return "Forge's land-play restrictions are not met for this card.";
        }
        boolean sorcerySpeed = sa.isSpell() ? !(c.isInstant() || c.hasKeyword(forge.game.keyword.Keyword.FLASH) || sa.withFlash(c, me))
                : sa.getRestrictions() != null && sa.getRestrictions().isSorcerySpeed();
        if (sa.isSpell() && zone != ZoneType.Hand && zone != ZoneType.Command) {
            return "It is in your " + zone + ", and nothing lets you cast it from there.";
        }
        if (sorcerySpeed && !me.canCastSorcery()) {
            String when = !myTurn ? "it is not your turn" : !ph.getPhase().isMain() ? "it is " + phaseName(ph.getPhase()) + ", not a main phase" : "the stack is not empty";
            return (sa.isSpell() ? "It can only be cast" : "That ability can only be activated") + " at sorcery speed (your main phase, empty stack), and " + when + ".";
        }
        if (!sa.isSpell() && sa.getPayCosts() != null && sa.getPayCosts().hasTapCost()) {
            if (c.isTapped()) return "It is already tapped, and this ability needs it to tap.";
            if (c.isCreature() && c.isSick()) return "It has summoning sickness: a creature can't use a {T} ability the turn it came under your control.";
        }
        return "Forge's restrictions for this ability are not met right now" + (sa.getRestrictions() != null ? "." : ".");
    }

    // ================================================================ state

    private JsonObject buildState(Decision d) {
        JsonObject s = new JsonObject();
        s.addProperty("matchId", id);
        Game g = game();
        Player me = human();
        if (g == null || me == null) {
            s.addProperty("phase", "STARTING");
            return s;
        }
        PlayerView meView = me.getView();
        PhaseHandler ph = g.getPhaseHandler();
        s.addProperty("turn", ph.getTurn());
        s.addProperty("phase", ph.getPhase() == null ? "" : ph.getPhase().name());
        s.addProperty("phaseLabel", ph.getPhase() == null ? "" : phaseName(ph.getPhase()));
        s.addProperty("activePlayerId", ph.getPlayerTurn() == null ? -1 : ph.getPlayerTurn().getId());
        s.addProperty("priorityPlayerId", ph.getPriorityPlayer() == null ? -1 : ph.getPriorityPlayer().getId());
        s.addProperty("humanPlayerId", me.getId());
        s.addProperty("gameType", g.getRules().getGameType().name());

        JsonArray players = new JsonArray();
        for (Player p : g.getRegisteredPlayers()) players.add(playerJson(p, me, meView));
        s.add("players", players);

        JsonArray stack = new JsonArray();
        for (SpellAbilityStackInstance si : g.getStack()) {
            JsonObject o = new JsonObject();
            Card src = si.getSourceCard();
            o.addProperty("id", si.getId());
            o.add("source", src == null ? null : cardJson(src, meView));
            o.addProperty("description", safe(si.getStackDescription()));
            o.addProperty("controllerId", si.getActivatingPlayer() == null ? -1 : si.getActivatingPlayer().getId());
            stack.add(o);
        }
        s.add("stack", stack);

        Combat combat = g.getCombat();
        if (combat != null && !combat.getAttackers().isEmpty()) {
            JsonArray atk = new JsonArray();
            for (Card a : combat.getAttackers()) {
                JsonObject o = new JsonObject();
                o.addProperty("attackerId", a.getId());
                GameEntity def = combat.getDefenderByAttacker(a);
                o.addProperty("defender", def == null ? "" : def.getName());
                if (def instanceof Player dp) o.addProperty("defenderPlayerId", dp.getId());
                if (def instanceof Card dc) o.addProperty("defenderCardId", dc.getId());
                JsonArray bl = new JsonArray();
                for (Card b : combat.getBlockers(a)) bl.add(b.getId());
                o.add("blockerIds", bl);
                atk.add(o);
            }
            s.add("combat", atk);
        }

        List<GameLogEntry> entries = g.getGameLog().getAllEntries();
        for (; logCursor < entries.size(); logCursor++) {
            GameLogEntry e = entries.get(logCursor);
            log.add(e.type().name() + "|" + safe(e.message()));
        }
        JsonArray logArr = new JsonArray();
        int from = Math.max(0, log.size() - 200);
        for (int i = from; i < log.size(); i++) {
            String[] parts = log.get(i).split("\\|", 2);
            JsonObject o = new JsonObject();
            o.addProperty("seq", i);
            o.addProperty("type", parts[0]);
            o.addProperty("message", parts.length > 1 ? parts[1] : "");
            logArr.add(o);
        }
        s.add("log", logArr);
        synchronized (lock) {
            JsonArray n = new JsonArray();
            notices.forEach(n::add);
            s.add("notices", n);
        }
        s.add("automation", automation());
        if (d != null) s.add("decision", d.toJson());
        if (over || g.isGameOver()) {
            JsonObject outcome = new JsonObject();
            if (g.getOutcome() != null) {
                outcome.addProperty("winner", g.getOutcome().getWinningLobbyPlayer() == null ? "draw" : g.getOutcome().getWinningLobbyPlayer().getName());
                outcome.addProperty("humanWon", g.getOutcome().isWinner(me.getLobbyPlayer()));
                outcome.addProperty("turns", g.getOutcome().getLastTurnNumber());
            }
            s.add("outcome", outcome);
        }
        return s;
    }

    private JsonObject playerJson(Player p, Player me, PlayerView meView) {
        JsonObject o = new JsonObject();
        o.addProperty("id", p.getId());
        o.addProperty("name", p.getName());
        o.addProperty("isHuman", p == me);
        o.addProperty("life", p.getLife());
        o.addProperty("lost", p.hasLost());
        o.addProperty("poison", p.getPoisonCounters());
        JsonObject counters = new JsonObject();
        for (var e : p.getCounters().entrySet()) counters.addProperty(counterName(e), counterCount(e));
        o.add("counters", counters);
        JsonObject pool = new JsonObject();
        for (byte color : ManaAtom.MANATYPES) {
            int n = p.getManaPool().getAmountOfColor(color);
            if (n > 0) pool.addProperty(colorName(color), n);
        }
        o.add("manaPool", pool);
        o.addProperty("handCount", p.getCardsIn(ZoneType.Hand).size());
        o.addProperty("libraryCount", p.getCardsIn(ZoneType.Library).size());
        o.addProperty("landsPlayedThisTurn", p.getLandsPlayedThisTurn());
        o.addProperty("maxLandPlays", p.getMaxLandPlays());
        if (p == me) o.add("hand", cards(p.getCardsIn(ZoneType.Hand), meView));
        else {
            JsonArray known = new JsonArray();
            for (Card c : p.getCardsIn(ZoneType.Hand)) if (c.getView().canBeShownTo(meView)) known.add(cardJson(c, meView));
            o.add("revealedHand", known);
        }
        o.add("battlefield", cards(p.getCardsIn(ZoneType.Battlefield), meView));
        o.add("graveyard", cards(p.getCardsIn(ZoneType.Graveyard), meView));
        o.add("exile", cards(p.getCardsIn(ZoneType.Exile), meView));
        o.add("command", cards(p.getCardsIn(ZoneType.Command), meView));
        JsonArray cmds = new JsonArray();
        for (Card c : p.getCommanders()) {
            JsonObject co = new JsonObject();
            co.addProperty("cardId", c.getId());
            co.addProperty("name", c.getName());
            // The commander list keeps the card as it was registered; a zone change makes a new
            // object, so the current zone comes from the game's current state of that card.
            Card cur = game() == null ? null : game().getCardState(c);
            if (cur == null) cur = c;
            co.addProperty("zone", cur.getZone() == null ? "" : cur.getZone().getZoneType().name());
            co.addProperty("timesCast", p.getCommanderCast(c));
            co.addProperty("tax", 2 * p.getCommanderCast(c));
            cmds.add(co);
        }
        o.add("commanders", cmds);
        JsonArray dmg = new JsonArray();
        for (Player other : game().getRegisteredPlayers()) {
            for (Card c : other.getCommanders()) {
                int n = p.getCommanderDamage(c);
                if (n > 0) {
                    JsonObject d = new JsonObject();
                    d.addProperty("commander", c.getName());
                    d.addProperty("fromPlayerId", other.getId());
                    d.addProperty("damage", n);
                    dmg.add(d);
                }
            }
        }
        o.add("commanderDamageTaken", dmg);
        return o;
    }

    private JsonArray cards(Iterable<Card> cs, PlayerView meView) {
        JsonArray a = new JsonArray();
        for (Card c : cs) if (!c.isImmutable()) a.add(cardJson(c, meView));
        return a;
    }

    private JsonObject cardJsonForced(Card c, PlayerView meView) { return cardJson(c, meView, true); }
    private JsonObject cardJson(Card c, PlayerView meView) { return cardJson(c, meView, false); }

    private JsonObject cardJson(Card c, PlayerView meView, boolean mayLook) {
        JsonObject o = new JsonObject();
        o.addProperty("id", c.getId());
        boolean visible = mayLook || c.getView().canBeShownTo(meView);
        o.addProperty("hidden", !visible);
        o.addProperty("controllerId", c.getController() == null ? -1 : c.getController().getId());
        o.addProperty("ownerId", c.getOwner() == null ? -1 : c.getOwner().getId());
        o.addProperty("zone", c.getZone() == null ? "" : c.getZone().getZoneType().name());
        o.addProperty("tapped", c.isTapped());
        o.addProperty("faceDown", c.isFaceDown());
        o.addProperty("token", c.isToken());
        if (!visible) {
            o.addProperty("name", "Face-down card");
            return o;
        }
        o.addProperty("name", c.getName());
        o.addProperty("state", c.getCurrentStateName().name());
        if (c.getPaperCard() != null) {
            o.addProperty("oracleName", c.getPaperCard().getName());
            o.addProperty("set", c.getPaperCard().getEdition());
            o.addProperty("collectorNumber", c.getPaperCard().getCollectorNumber());
        }
        o.addProperty("typeLine", safe(c.getType().toString()));
        o.addProperty("isLand", c.isLand());
        o.addProperty("isCreature", c.isCreature());
        o.addProperty("isCommander", c.isCommander());
        o.addProperty("manaCost", c.getManaCost() == null ? "" : c.getManaCost().getSimpleString());
        o.addProperty("cmc", c.getCMC());
        if (c.isCreature()) {
            o.addProperty("power", c.getNetPower());
            o.addProperty("toughness", c.getNetToughness());
            o.addProperty("damage", c.getDamage());
            o.addProperty("sick", c.isSick());
        }
        if (c.isPlaneswalker()) o.addProperty("loyalty", c.getCurrentLoyalty());
        JsonObject counters = new JsonObject();
        for (var e : c.getCounters().entrySet()) counters.addProperty(counterName(e), counterCount(e));
        o.add("counters", counters);
        if (c.getAttachedTo() != null) o.addProperty("attachedToId", c.getAttachedTo().getId());
        o.addProperty("attacking", game().getCombat() != null && game().getCombat().isAttacking(c));
        o.addProperty("text", safe(c.getView().getText()));
        return o;
    }

    // ================================================================ helpers

    String describe(Object t, PlayerView viewer) {
        Player me = human();
        PlayerView pv = viewer != null ? viewer : me == null ? null : me.getView();
        if (t instanceof CardView cv) {
            if (pv != null && !cv.canBeShownTo(pv) && !cv.mayPlayerLook(pv)) return "a hidden card";
            return cv.getName() + (cv.getZone() != null ? " (" + zoneLabel(cv.getZone()) + ")" : "");
        }
        if (t instanceof PlayerView p) return p.getName();
        if (t instanceof SpellAbilityView sv) return safe(sv.getDescription());
        if (t instanceof GameEntityView gv) return gv.getName();
        return String.valueOf(t);
    }

    private static String zoneLabel(ZoneType z) { return z.name().toLowerCase(); }

    private Player findPlayer(int id) {
        for (Player p : game().getRegisteredPlayers()) if (p.getId() == id) return p;
        return null;
    }

    private static boolean canAfford(SpellAbility sa, Player p) {
        if (sa.getPayCosts() == null || !sa.getPayCosts().hasManaCost()) return true;
        return withAi(p, () -> ComputerUtilMana.canPayManaCost(sa, p, 0, false));
    }

    /** Forge's own predictive checks run under an AI controller so they never prompt the human. */
    private static boolean withAi(Player p, java.util.function.BooleanSupplier body) {
        boolean[] r = new boolean[1];
        p.runWithController(() -> r[0] = body.getAsBoolean(),
                new PlayerControllerAi(p.getGame(), p, p.getOriginalLobbyPlayer()));
        return r[0];
    }

    static String colorName(byte color) {
        return switch (color) {
            case ManaAtom.WHITE -> "W";
            case ManaAtom.BLUE -> "U";
            case ManaAtom.BLACK -> "B";
            case ManaAtom.RED -> "R";
            case ManaAtom.GREEN -> "G";
            default -> "C";
        };
    }

    static String phaseName(PhaseType p) {
        return p == null ? "" : p.nameForUi;
    }

    private static String counterName(Object e) {
        if (e instanceof Map.Entry<?, ?> me) return ((CounterType) me.getKey()).getName();
        return ((CounterType) ((com.google.common.collect.Multiset.Entry<?>) e).getElement()).getName();
    }
    private static int counterCount(Object e) {
        if (e instanceof Map.Entry<?, ?> me) return ((Number) me.getValue()).intValue();
        return ((com.google.common.collect.Multiset.Entry<?>) e).getCount();
    }

    private static String safe(String s) { return s == null ? "" : s; }
}
