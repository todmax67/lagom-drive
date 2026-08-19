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
    private boolean giaChiesto = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // I plugin locali si registrano PRIMA del bridge
        registerPlugin(PresidioPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * Il permesso notifiche si chiede a finestra VIVA, non dentro onCreate:
     * lì l'Activity non è ancora in stato di mostrare un dialogo e la
     * richiesta può essere inghiottita senza che compaia niente. Senza la
     * notifica persistente non esiste servizio in primo piano, e a schermo
     * spento Android congela la webview: la registrazione muore.
     */
    @Override
    public void onResume() {
        super.onResume();
        if (giaChiesto) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            giaChiesto = true;
            getWindow().getDecorView().post(() ->
                ActivityCompat.requestPermissions(
                    this,
                    new String[] { Manifest.permission.POST_NOTIFICATIONS },
                    CODICE_NOTIFICHE
                )
            );
        }
    }
}
