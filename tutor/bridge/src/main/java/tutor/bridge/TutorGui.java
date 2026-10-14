package tutor.bridge;

import forge.GuiDesktop;
import forge.gamemodes.match.HostedMatch;
import forge.gui.interfaces.IGuiGame;
import forge.item.PaperCard;
import forge.localinstance.skin.FSkinProp;
import forge.localinstance.skin.ISkinImage;
import forge.sound.IAudioClip;
import forge.sound.IAudioMusic;
import forge.util.FSerializableFunction;

import java.io.File;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * Forge's GUI base for a process with no screen.
 *
 * <p>Forge's desktop GUI already runs headless (see Forge's own {@code HeadlessStartupTest}), so
 * this extends it rather than re-implementing it. What changes:
 * <ul>
 *   <li>the "event dispatch thread" is one thread this bridge owns, so inputs are fed the same
 *       way a desktop click feeds them, without depending on Swing;</li>
 *   <li>no dialog, sound or file chooser ever opens: anything a match needs to ask goes through
 *       {@link BridgeGuiGame} as a pending decision instead;</li>
 *   <li>the assets directory comes from {@code forge.assets} (the Forge checkout's
 *       {@code forge-gui/} folder), not from the working directory.</li>
 * </ul>
 */
public final class TutorGui extends GuiDesktop {
    private final String assetsDir;
    private final ExecutorService ui = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "tutor-ui");
        t.setDaemon(true);
        uiThread = t;
        return t;
    });
    private volatile Thread uiThread;

    public TutorGui(String assetsDir) {
        this.assetsDir = assetsDir.endsWith("/") ? assetsDir : assetsDir + "/";
    }

    @Override public String getAssetsDir() { return assetsDir; }

    @Override public void invokeInEdtNow(Runnable proc) { proc.run(); }

    @Override public void invokeInEdtLater(Runnable proc) { ui.submit(guard(proc)); }

    @Override
    public void invokeInEdtAndWait(Runnable proc) {
        if (isGuiThread()) { proc.run(); return; }
        try {
            ui.submit(guard(proc)).get();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @Override public boolean isGuiThread() { return Thread.currentThread() == uiThread; }

    /** Runs on the UI thread and returns once it has run; lets a caller wait for queued prompts. */
    public void flushUi() {
        if (isGuiThread()) return;
        try {
            Future<?> f = ui.submit(() -> { });
            f.get();
        } catch (Exception ignored) { }
    }

    public void runOnUi(Runnable r) { invokeInEdtAndWait(r); }

    private static Runnable guard(Runnable r) {
        return () -> {
            try { r.run(); } catch (Throwable t) { t.printStackTrace(); }
        };
    }

    @Override public IGuiGame getNewGuiGame() { return new BridgeGuiGame(null); }
    @Override public HostedMatch hostMatch() { return new HostedMatch(); }

    // Nothing below may ever block on a person: a match's questions go through BridgeGuiGame.
    @Override public int showOptionDialog(String m, String t, FSkinProp i, List<String> o, int d) { log(t, m); return -1; }
    @Override public String showInputDialog(String m, String t, FSkinProp i, String init, List<String> o, boolean num) {
        log(t, m);
        if (init != null) return init;
        if (o != null && !o.isEmpty()) return o.get(0);
        return num ? "0" : "";
    }
    @Override public void showImageDialog(ISkinImage image, String m, String t) { log(t, m); }
    @Override public String showFileDialog(String t, String d) { return null; }
    @Override public File getSaveFile(File f) { return null; }
    @Override public void showBugReportDialog(String t, String text, boolean exit) { log("bug report: " + t, text); }
    @Override public <T> List<T> getChoices(String m, int min, int max, Collection<T> c, Collection<T> s, FSerializableFunction<T, String> d) {
        throw new IllegalStateException("Out-of-match choice requested headlessly: " + m);
    }
    @Override public <T> List<T> order(String t, String top, int a, int b, List<T> s, List<T> d) {
        throw new IllegalStateException("Out-of-match ordering requested headlessly: " + t);
    }
    @Override public PaperCard chooseCard(String t, String m, List<PaperCard> l) { return null; }
    @Override public void showCardList(String t, String m, List<PaperCard> l) { }
    @Override public boolean showBoxedProduct(String t, String m, List<PaperCard> l) { return false; }
    @Override public IAudioClip createAudioClip(String f) { return null; }
    @Override public IAudioMusic createAudioMusic(String f) { return null; }
    @Override public void startAltSoundSystem(String f, boolean s) { }
    @Override public void showSpellShop() { }
    @Override public void showBazaar() { }
    @Override public void preventSystemSleep(boolean p) { }
    @Override public void copyToClipboard(String t) { }
    @Override public void browseToUrl(String u) { }

    private static void log(String title, String message) {
        System.err.println("[forge] " + title + ": " + message);
    }
}
