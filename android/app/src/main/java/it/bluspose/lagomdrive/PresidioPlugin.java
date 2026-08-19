package it.bluspose.lagomdrive;

import android.Manifest;
import android.app.ActivityManager;
import android.content.Intent;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Il ponte del presidio: il core web (canale-nativo.ts) chiede il servizio in
 * primo piano all'avvio della registrazione e lo congeda alla fine.
 *
 * Ogni esito torna indietro DICHIARATO. La prima versione risolveva sempre e
 * inghiottiva le eccezioni: il servizio non partiva, nessuno lo sapeva, e la
 * registrazione moriva a schermo spento senza che l'app avesse niente da dire
 * (24 minuti persi sul campo il 19 agosto). Un guasto che si traveste da
 * silenzio è il difetto peggiore di tutti.
 */
@CapacitorPlugin(name = "Presidio")
public class PresidioPlugin extends Plugin {

    private static final int CODICE_NOTIFICHE = 4711;
    private static final long BATTITO_MS = 1000;

    /**
     * Il battito del presidio: un tick al secondo dal lato nativo, consegnato
     * alla webview via bridge. A schermo spento Chromium congela i TIMER
     * JavaScript della pagina nascosta anche col servizio in primo piano vivo
     * (visto sul campo: buchi di 10 minuti con servizio attivo) — ma
     * l'esecuzione di JS iniettato dal nativo continua. Il ciclo di lettura
     * cammina su questo battito, non su setTimeout.
     */
    private final Handler battito = new Handler(Looper.getMainLooper());
    private boolean battitoAttivo = false;
    private final Runnable colpo = new Runnable() {
        @Override
        public void run() {
            if (!battitoAttivo) return;
            notifyListeners("battito", new JSObject());
            battito.postDelayed(this, BATTITO_MS);
        }
    };

    private void avviaBattito() {
        if (battitoAttivo) return;
        battitoAttivo = true;
        battito.postDelayed(colpo, BATTITO_MS);
    }

    private void fermaBattito() {
        battitoAttivo = false;
        battito.removeCallbacks(colpo);
    }

    /** Il permesso notifiche: su Android 13+ è negato finché non lo si chiede,
     *  e senza di lui la notifica del servizio non si vede — l'utente non ha
     *  modo di sapere se la raccolta è viva. */
    @PluginMethod
    public void chiediPermessi(PluginCall call) {
        boolean serve =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED;
        if (serve && getActivity() != null) {
            ActivityCompat.requestPermissions(
                getActivity(),
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                CODICE_NOTIFICHE
            );
        }
        JSObject esito = new JSObject();
        esito.put("chiesto", serve);
        call.resolve(esito);
    }

    @PluginMethod
    public void avvia(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), PresidioService.class);
            ContextCompat.startForegroundService(getContext(), intent);
        } catch (Exception e) {
            call.reject("Servizio in primo piano non avviato: " + e.getMessage(), e);
            return;
        }
        avviaBattito();
        JSObject esito = new JSObject();
        esito.put("attivo", inEsecuzione());
        esito.put("notifiche", notifichePermesse());
        esito.put("batteria", senzaRestrizioniBatteria());
        call.resolve(esito);
    }

    @PluginMethod
    public void ferma(PluginCall call) {
        fermaBattito();
        getContext().stopService(new Intent(getContext(), PresidioService.class));
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        fermaBattito();
        super.handleOnDestroy();
    }

    /** Lo stato vero, per la UI: il servizio gira davvero? */
    @PluginMethod
    public void stato(PluginCall call) {
        JSObject esito = new JSObject();
        esito.put("attivo", inEsecuzione());
        esito.put("notifiche", notifichePermesse());
        esito.put("batteria", senzaRestrizioniBatteria());
        call.resolve(esito);
    }

    /**
     * L'app è esente dall'ottimizzazione batteria? Senza esenzione Android può
     * congelare la webview anche col servizio in primo piano: è il "background"
     * che l'utente cercava nelle impostazioni e non trovava.
     */
    @PluginMethod
    public void apriImpostazioniBatteria(PluginCall call) {
        try {
            Intent i = new Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + getContext().getPackageName())
            );
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            // Il dialogo diretto può non esistere: si ripiega sulla scheda app
            try {
                Intent i = new Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Impostazioni non apribili: " + e2.getMessage());
            }
        }
    }

    private boolean senzaRestrizioniBatteria() {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm == null || pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    private boolean notifichePermesse() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    @SuppressWarnings("deprecation")
    private boolean inEsecuzione() {
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return false;
        for (ActivityManager.RunningServiceInfo s : am.getRunningServices(Integer.MAX_VALUE)) {
            if (PresidioService.class.getName().equals(s.service.getClassName())) return true;
        }
        return false;
    }
}
