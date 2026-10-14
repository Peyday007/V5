package tutor.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.function.Function;

/**
 * One thing Forge is waiting for the human to decide.
 *
 * <p>{@link #view} is what the client is shown; {@link #actionIds} is the closed set of action ids
 * the bridge will accept for it. An answer is applied only if it names the current revision and
 * an id in this set — anything else is refused without touching the game.
 */
final class Decision {
    /** "input" for Forge's click-driven inputs, "dialog" for a blocking question. */
    final String kind;
    final JsonObject view = new JsonObject();
    final JsonArray actions = new JsonArray();
    final Set<String> actionIds = new LinkedHashSet<>();
    /** For dialogs: turns an accepted answer into the value Forge is waiting for; null on error. */
    Function<JsonObject, String> handler;
    /** For priority decisions: the exact Forge ability objects behind each "play:" action id. */
    final java.util.Map<String, Object> abilities = new java.util.HashMap<>();
    /** What Forge is actually waiting on (the input object); two decisions with the same origin and actions are one decision. */
    Object origin;

    Decision(String kind, String type, String prompt) {
        this.kind = kind;
        view.addProperty("kind", kind);
        view.addProperty("type", type);
        view.addProperty("prompt", prompt == null ? "" : prompt);
    }

    JsonObject action(String id, String label, String category) {
        JsonObject a = new JsonObject();
        a.addProperty("id", id);
        a.addProperty("label", label);
        a.addProperty("category", category);
        actions.add(a);
        actionIds.add(id);
        return a;
    }

    JsonObject toJson() {
        JsonObject o = view.deepCopy();
        o.add("actions", actions.deepCopy());
        return o;
    }
}
