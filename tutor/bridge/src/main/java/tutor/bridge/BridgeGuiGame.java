package tutor.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import forge.LobbyPlayer;
import forge.deck.CardPool;
import forge.game.GameEntityView;
import forge.game.card.CardView;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.IHasIcon;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.gamemodes.match.AbstractGuiGame;
import forge.item.PaperCard;
import forge.localinstance.skin.FSkinProp;
import forge.player.PlayerZoneUpdate;
import forge.trackable.TrackableCollection;
import forge.trackable.TrackableObject;
import forge.util.FSerializableFunction;
import forge.util.ITriggerEvent;
import forge.game.GameState;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;

/**
 * The human player's GUI, with no screen behind it.
 *
 * <p>Every method Forge calls to <em>ask</em> something becomes a {@link Decision} published by
 * {@link MatchSession} and blocks until the tutor answers it; every method Forge calls to
 * <em>show</em> something is recorded or ignored. Nothing here decides anything on the human's
 * behalf, and nothing chooses a default for them.
 */
final class BridgeGuiGame extends AbstractGuiGame {
    private MatchSession session;
    private volatile String promptMessage = "";
    private volatile String okLabel = "OK", cancelLabel = "Cancel";
    private volatile boolean okEnabled, cancelEnabled;

    BridgeGuiGame(MatchSession session) { this.session = session; }

    void attach(MatchSession s) { this.session = s; }

    String promptMessage() { return promptMessage; }
    String okLabel() { return okLabel; }
    String cancelLabel() { return cancelLabel; }
    boolean okEnabled() { return okEnabled; }
    boolean cancelEnabled() { return cancelEnabled; }

    // ---------------------------------------------------------------- prompts the inputs draw

    @Override
    public void showPromptMessage(PlayerView playerView, String message, CardView card) {
        promptMessage = message == null ? "" : message;
        if (session != null) session.inputChanged();
    }

    @Override
    public void updateButtons(PlayerView owner, String label1, String label2, boolean enable1, boolean enable2, boolean focus1) {
        okLabel = label1; cancelLabel = label2; okEnabled = enable1; cancelEnabled = enable2;
        if (session != null) session.inputChanged();
    }

    private final java.util.Set<CardView> selectableCopy = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final java.util.Set<CardView> weakCopy = java.util.concurrent.ConcurrentHashMap.newKeySet();
    List<CardView> selectableCards() { List<CardView> l = new ArrayList<>(selectableCopy); l.addAll(weakCopy); return l; }

    @Override
    public void setWeaklySelectable(Iterable<CardView> cards) {
        super.setWeaklySelectable(cards);
        weakCopy.clear();
        cards.forEach(weakCopy::add);
    }

    @Override
    public void clearWeaklySelectable() {
        super.clearWeaklySelectable();
        weakCopy.clear();
    }

    @Override
    public void setSelectables(Iterable<CardView> cards, int min, int max) {
        super.setSelectables(cards, min, max);
        cards.forEach(selectableCopy::add);
        if (session != null) session.inputChanged();
    }

    @Override
    public void setSelectableTargets(Iterable<? extends TrackableObject> targets) {
        super.setSelectableTargets(targets);
        if (session != null) session.inputChanged();
    }

    @Override
    public void clearSelectables() {
        super.clearSelectables();
        selectableCopy.clear();
        if (session != null) session.inputChanged();
    }

    @Override
    public void setHighlighted(Iterable<? extends TrackableObject> objects, boolean b) {
        super.setHighlighted(objects, b);
        if (session != null) session.inputChanged();
    }

    @Override
    public void awaitInput(CountDownLatch done) throws InterruptedException {
        session.awaitInput(done);
    }

    @Override public void flashIncorrectAction() { if (session != null) session.notice("Forge did not accept that selection."); }
    @Override public void alertUser() { }
    @Override protected void updateCurrentPlayer(PlayerView player) { }
    @Override public void openView(TrackableCollection<PlayerView> myPlayers) { }
    @Override public void afterGameEnd() { if (session != null) session.gameEnded(); }
    @Override public void finishGame() { if (session != null) session.gameEnded(); }
    @Override public void showCombat() { }
    @Override public void setPanelSelection(CardView hostCard) { }
    @Override public void setCard(CardView card) { }
    @Override public void setPlayerAvatar(LobbyPlayer player, IHasIcon ihi) { }
    @Override public GameState getGamestate() { return null; }
    @Override public void updateZones(Iterable<PlayerZoneUpdate> zones) { }
    @Override public boolean isUiSetToSkipPhase(PlayerView playerTurn, PhaseType phase) {
        return session != null && session.skipPhase(playerTurn, phase);
    }

    @Override public void message(String message, String title) { if (session != null) session.notice(join(title, message)); }
    @Override public void showErrorDialog(String message, String title) { if (session != null) session.notice(join(title, message)); }

    @Override
    public <T> void reveal(String message, List<T> items) {
        List<String> names = new ArrayList<>();
        for (T t : items) names.add(session.describe(t, null));
        session.notice(message + ": " + String.join(", ", names));
    }

    // ---------------------------------------------------------------- questions

    @Override
    public SpellAbilityView getAbilityToPlay(CardView hostCard, List<SpellAbilityView> abilities, ITriggerEvent triggerEvent) {
        if (abilities.isEmpty()) return null;
        // As Forge's desktop GUI does: one ability and no explicit click means there is nothing to ask.
        if (abilities.size() == 1 && triggerEvent == null) return abilities.get(0);
        Integer i = chooseIndex("ability", "Choose which ability of " + session.describe(hostCard, null) + " to use", abilities, null, true, hostCard);
        return i == null ? null : abilities.get(i);
    }

    @Override
    public boolean confirm(CardView c, String question, boolean defaultIsYes, List<String> options) {
        List<String> opts = options == null || options.isEmpty() ? List.of("Yes", "No") : options;
        Integer i = chooseIndex("confirm", question, opts, null, false, c);
        return i != null && i == 0;
    }

    @Override
    public boolean showConfirmDialog(String message, String title, String yes, String no, boolean defaultYes) {
        Integer i = chooseIndex("confirm", join(title, message), List.of(yes, no), null, false, null);
        return i != null && i == 0;
    }

    @Override
    public int showOptionDialog(String message, String title, FSkinProp icon, List<String> options, int defaultOption) {
        if (options == null || options.isEmpty()) { session.notice(join(title, message)); return -1; }
        Integer i = chooseIndex("option", join(title, message), options, null, false, null);
        return i == null ? -1 : i;
    }

    @Override
    public String showInputDialog(String message, String title, FSkinProp icon, String initialInput, List<String> inputOptions, boolean isNumeric) {
        if (inputOptions != null && !inputOptions.isEmpty()) {
            Integer i = chooseIndex("option", join(title, message), inputOptions, null, true, null);
            return i == null ? null : inputOptions.get(i);
        }
        Decision d = new Decision("dialog", isNumeric ? "number" : "text", join(title, message));
        d.view.addProperty("initial", initialInput == null ? "" : initialInput);
        d.action("submit", "Submit", "answer");
        d.action("cancel", "Cancel", "answer");
        JsonObject a = session.ask(d);
        if (!"submit".equals(a.get("id").getAsString())) return null;
        return a.has("text") ? a.get("text").getAsString() : "";
    }

    @Override
    public <T> List<T> getChoices(String message, int min, int max, List<T> choices, List<T> selected, FSerializableFunction<T, String> display) {
        if (choices == null || choices.isEmpty()) return new ArrayList<>();
        if (min < 0) { reveal(message, choices); return new ArrayList<>(); }
        List<Integer> idx = chooseMany("choose", message, min, max, choices, display, null);
        List<T> out = new ArrayList<>();
        for (int i : idx) out.add(choices.get(i));
        return out;
    }

    @Override
    public <T> OrderResult<T> order(String title, String top, int remMin, int remMax, List<T> source, List<T> dest, CardView ref, boolean sideboarding, boolean remember) {
        List<T> all = new ArrayList<>();
        if (dest != null) all.addAll(dest);
        all.addAll(source);
        int n = all.size();
        int pickMin, pickMax;
        if (remMin <= 0 && remMax <= 0) { pickMin = n; pickMax = n; }
        else { pickMin = Math.max(0, n - Math.max(remMax, 0)); pickMax = n - Math.max(remMin, 0); }
        Decision d = new Decision("dialog", "order", join(title, top));
        d.view.add("options", options(all, null));
        d.view.addProperty("min", pickMin);
        d.view.addProperty("max", pickMax);
        d.action("order", "Confirm order", "answer");
        final int fMin = pickMin, fMax = pickMax;
        d.handler = a -> checkIndices(a, n, fMin, fMax, true);
        JsonObject a = session.ask(d);
        List<T> out = new ArrayList<>();
        for (JsonElement e : a.getAsJsonArray("values")) out.add(all.get(e.getAsInt()));
        return new OrderResult<>(out, false);
    }

    @Override
    public List<PaperCard> sideboard(CardPool sideboard, CardPool main, String message) {
        return Collections.emptyList();
    }

    @Override
    public GameEntityView chooseSingleEntityForEffect(String title, List<? extends GameEntityView> optionList, DelayedReveal delayedReveal, boolean isOptional) {
        if (optionList == null || optionList.isEmpty()) return null;
        List<Integer> idx = chooseMany("choose", title, isOptional ? 0 : 1, 1, optionList, null, null);
        return idx.isEmpty() ? null : optionList.get(idx.get(0));
    }

    @Override
    public List<GameEntityView> chooseEntitiesForEffect(String title, List<? extends GameEntityView> optionList, int min, int max, DelayedReveal delayedReveal) {
        if (optionList == null || optionList.isEmpty()) return new ArrayList<>();
        List<Integer> idx = chooseMany("choose", title, min, max, optionList, null, null);
        List<GameEntityView> out = new ArrayList<>();
        for (int i : idx) out.add(optionList.get(i));
        return out;
    }

    @Override
    public List<CardView> manipulateCardList(String title, Iterable<CardView> cards, Iterable<CardView> manipulable, boolean toTop, boolean toBottom, boolean toAnywhere) {
        List<CardView> all = new ArrayList<>();
        cards.forEach(all::add);
        return order(title, "Arrange these cards (first = top)", 0, 0, all, null, null, false, false).ordered();
    }

    @Override
    public Map<CardView, Integer> assignCombatDamage(CardView attacker, List<CardView> blockers, int damage, GameEntityView defender, boolean overrideOrder, boolean maySkip) {
        List<Object> targets = new ArrayList<>(blockers);
        if (defender != null) targets.add(defender);
        Map<Integer, Integer> amounts = assign("assignDamage",
                "Assign " + damage + " combat damage from " + session.describe(attacker, null)
                        + (defender != null ? " (damage beyond lethal may go to " + session.describe(defender, null) + ")" : ""),
                targets, damage, false, attacker);
        if (amounts == null) return null;
        Map<CardView, Integer> out = new LinkedHashMap<>();
        for (Map.Entry<Integer, Integer> e : amounts.entrySet()) {
            Object t = targets.get(e.getKey());
            if (e.getValue() <= 0) continue;
            out.put(t instanceof CardView cv && blockers.contains(cv) ? cv : null, e.getValue());
        }
        return out;
    }

    @Override
    public Map<Object, Integer> assignGenericAmount(CardView effectSource, Map<Object, Integer> target, int amount, boolean atLeastOne, String amountLabel) {
        List<Object> targets = new ArrayList<>(target.keySet());
        Map<Integer, Integer> amounts = assign("assignAmount",
                "Divide " + amount + " " + (amountLabel == null ? "" : amountLabel) + " from " + session.describe(effectSource, null),
                targets, amount, atLeastOne, effectSource);
        Map<Object, Integer> out = new HashMap<>();
        if (amounts == null) return out;
        for (Map.Entry<Integer, Integer> e : amounts.entrySet()) out.put(targets.get(e.getKey()), e.getValue());
        return out;
    }

    // ---------------------------------------------------------------- helpers

    private <T> Integer chooseIndex(String type, String prompt, List<T> items, FSerializableFunction<T, String> display, boolean cancellable, CardView about) {
        Decision d = new Decision("dialog", type, prompt);
        d.view.add("options", options(items, display));
        if (about != null) d.view.addProperty("aboutCardId", about.getId());
        for (int i = 0; i < items.size(); i++) d.action("opt:" + i, label(items.get(i), display), "answer");
        if (cancellable) d.action("cancel", "Cancel", "answer");
        JsonObject a = session.ask(d);
        String id = a.get("id").getAsString();
        if (!id.startsWith("opt:")) return null;
        return Integer.parseInt(id.substring(4));
    }

    private <T> List<Integer> chooseMany(String type, String prompt, int min, int max, List<T> items, FSerializableFunction<T, String> display, CardView about) {
        int fMax = max < 0 ? items.size() : Math.min(max, items.size());
        int fMin = Math.min(Math.max(min, 0), fMax);
        Decision d = new Decision("dialog", type, prompt);
        d.view.add("options", options(items, display));
        d.view.addProperty("min", fMin);
        d.view.addProperty("max", fMax);
        if (fMax == 1) {
            for (int i = 0; i < items.size(); i++) d.action("opt:" + i, label(items.get(i), display), "answer");
            if (fMin == 0) d.action("none", "Choose nothing", "answer");
        } else {
            d.action("choose", "Confirm selection", "answer");
            d.handler = a -> checkIndices(a, items.size(), fMin, fMax, false);
        }
        JsonObject a = session.ask(d);
        String id = a.get("id").getAsString();
        List<Integer> out = new ArrayList<>();
        if (id.startsWith("opt:")) out.add(Integer.parseInt(id.substring(4)));
        else if ("choose".equals(id)) for (JsonElement e : a.getAsJsonArray("values")) out.add(e.getAsInt());
        return out;
    }

    private Map<Integer, Integer> assign(String type, String prompt, List<Object> targets, int total, boolean atLeastOne, CardView about) {
        Decision d = new Decision("dialog", type, prompt);
        d.view.add("options", options(targets, null));
        d.view.addProperty("total", total);
        d.view.addProperty("atLeastOne", atLeastOne);
        if (about != null) d.view.addProperty("aboutCardId", about.getId());
        d.action("assign", "Confirm assignment", "answer");
        d.handler = a -> {
            if (!a.has("amounts") || !a.get("amounts").isJsonObject()) return "amounts is required";
            int sum = 0;
            for (Map.Entry<String, JsonElement> e : a.getAsJsonObject("amounts").entrySet()) {
                int k;
                try { k = Integer.parseInt(e.getKey()); } catch (NumberFormatException ex) { return "unknown target " + e.getKey(); }
                if (k < 0 || k >= targets.size()) return "unknown target " + e.getKey();
                int v = e.getValue().getAsInt();
                if (v < 0) return "amounts cannot be negative";
                if (atLeastOne && v < 1) return "each target needs at least one";
                sum += v;
            }
            return sum == total ? null : "the amounts must add up to " + total + " (got " + sum + ")";
        };
        JsonObject a = session.ask(d);
        Map<Integer, Integer> out = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> e : a.getAsJsonObject("amounts").entrySet()) {
            out.put(Integer.parseInt(e.getKey()), e.getValue().getAsInt());
        }
        return out;
    }

    private static String checkIndices(JsonObject a, int n, int min, int max, boolean distinct) {
        if (!a.has("values") || !a.get("values").isJsonArray()) return "values is required";
        JsonArray v = a.getAsJsonArray("values");
        if (v.size() < min || v.size() > max) return "choose between " + min + " and " + max + " (got " + v.size() + ")";
        java.util.Set<Integer> seen = new java.util.HashSet<>();
        for (JsonElement e : v) {
            int i = e.getAsInt();
            if (i < 0 || i >= n) return "option " + i + " does not exist";
            if (!seen.add(i)) return "option " + i + " was chosen twice";
        }
        return null;
    }

    private <T> JsonArray options(List<T> items, FSerializableFunction<T, String> display) {
        JsonArray arr = new JsonArray();
        for (int i = 0; i < items.size(); i++) {
            T t = items.get(i);
            JsonObject o = new JsonObject();
            o.addProperty("index", i);
            o.addProperty("label", label(t, display));
            if (t instanceof CardView cv) o.addProperty("cardId", cv.getId());
            if (t instanceof PlayerView pv) o.addProperty("playerId", pv.getId());
            if (t instanceof SpellAbilityView sv && sv.getHostCard() != null) o.addProperty("cardId", sv.getHostCard().getId());
            arr.add(o);
        }
        return arr;
    }

    private <T> String label(T t, FSerializableFunction<T, String> display) {
        if (display != null) {
            try { return display.apply(t); } catch (Exception ignored) { }
        }
        return session.describe(t, null);
    }

    private static String join(String title, String message) {
        if (title == null || title.isBlank() || "Forge".equals(title)) return message == null ? "" : message;
        return title + ": " + (message == null ? "" : message);
    }
}
