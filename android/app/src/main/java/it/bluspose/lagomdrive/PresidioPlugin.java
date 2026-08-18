package it.bluspose.lagomdrive;

import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Il ponte del presidio: il core web (canale-nativo.ts) chiama avvia/ferma
 * all'avvio e alla fermata della registrazione. Sul web puro il plugin non
 * esiste e le chiamate sono no-op: il contratto è tutto lì.
 */
@CapacitorPlugin(name = "Presidio")
public class PresidioPlugin extends Plugin {

    @PluginMethod
    public void avvia(PluginCall call) {
        Intent intent = new Intent(getContext(), PresidioService.class);
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void ferma(PluginCall call) {
        getContext().stopService(new Intent(getContext(), PresidioService.class));
        call.resolve();
    }
}
