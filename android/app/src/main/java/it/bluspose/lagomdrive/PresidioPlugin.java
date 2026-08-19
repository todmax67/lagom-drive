package it.bluspose.lagomdrive;

import android.Manifest;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

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
        JSObject esito = new JSObject();
        esito.put("attivo", inEsecuzione());
        esito.put("notifiche", notifichePermesse());
        call.resolve(esito);
    }

    @PluginMethod
    public void ferma(PluginCall call) {
        getContext().stopService(new Intent(getContext(), PresidioService.class));
        call.resolve();
    }

    /** Lo stato vero, per la UI: il servizio gira davvero? */
    @PluginMethod
    public void stato(PluginCall call) {
        JSObject esito = new JSObject();
        esito.put("attivo", inEsecuzione());
        esito.put("notifiche", notifichePermesse());
        call.resolve(esito);
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
