package it.bluspose.lagomdrive;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final int CODICE_NOTIFICHE = 4711;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // I plugin locali si registrano PRIMA del bridge
        registerPlugin(PresidioPlugin.class);
        super.onCreate(savedInstanceState);

        // Il permesso notifiche si chiede all'APERTURA, quando l'utente ha il
        // telefono in mano: senza la notifica persistente non esiste servizio
        // in primo piano, e a schermo spento Android congela la webview —
        // la registrazione muore. Chiederlo al momento della partenza
        // significherebbe far comparire un dialogo mentre si guida.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                CODICE_NOTIFICHE
            );
        }
    }
}
