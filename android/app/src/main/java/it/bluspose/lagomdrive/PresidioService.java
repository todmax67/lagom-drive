package it.bluspose.lagomdrive;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Il servizio in primo piano del presidio (bussola §5.6): tiene vivi il
 * processo, la webview e il canale BLE a schermo spento, con un partial wake
 * lock. È un guardiano, non un lavoratore: la registrazione vera vive nel
 * core web ri-ospitato.
 */
public class PresidioService extends Service {

    private static final String CANALE_NOTIFICHE = "presidio";
    private static final int ID_NOTIFICA = 1;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager gestore = getSystemService(NotificationManager.class);
        if (gestore.getNotificationChannel(CANALE_NOTIFICHE) == null) {
            gestore.createNotificationChannel(new NotificationChannel(
                    CANALE_NOTIFICHE,
                    "Registrazione OBD",
                    NotificationManager.IMPORTANCE_LOW));
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Intent apri = new Intent(this, MainActivity.class);
        PendingIntent tocco = PendingIntent.getActivity(
                this, 0, apri, PendingIntent.FLAG_IMMUTABLE);

        Notification notifica = new NotificationCompat.Builder(this, CANALE_NOTIFICHE)
                .setContentTitle("Lagom Drive")
                .setContentText("Registrazione OBD in corso")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(tocco)
                .setOngoing(true)
                .build();

        // Il tipo location si dichiara solo se il permesso c'è: su Android 14+
        // dichiararlo senza permesso è una SecurityException all'avvio
        int tipi = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED) {
            tipi |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ID_NOTIFICA, notifica, tipi);
        } else {
            startForeground(ID_NOTIFICA, notifica);
        }

        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lagom:presidio");
            wakeLock.setReferenceCounted(false);
        }
        // Tetto di sicurezza: dodici ore, più di qualunque guida vera. Se
        // qualcosa impedisse la fermata, il lock non terrebbe sveglio il
        // telefono per sempre.
        wakeLock.acquire(12 * 60 * 60 * 1000L);

        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
