package it.bluspose.lagomdrive;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import android.webkit.CookieManager;

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

    /**
     * Il cookie di sessione va SCRITTO SU DISCO quando l'app passa in secondo
     * piano. La WebView di Android tiene i cookie in memoria e li riversa da
     * sola solo ogni tanto: se il processo viene ucciso prima — e con il
     * presidio l'app sta in secondo piano quasi sempre, che è la condizione in
     * cui Android uccide per primo — il cookie non arriva mai al disco e al
     * lancio dopo la sessione non c'è più.
     *
     * Da fuori si vede come "devo rifare il login ogni volta", ed è per questo
     * che sembrava un problema di autenticazione: il grant Volvo era intatto
     * (i token si rinnovavano regolarmente lato server), spariva solo il
     * cookie di NextAuth, che di suo dura novanta giorni.
     */
    @Override
    public void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }
}
