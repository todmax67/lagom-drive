package it.bluspose.lagomdrive;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // I plugin locali si registrano PRIMA del bridge
        registerPlugin(PresidioPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
