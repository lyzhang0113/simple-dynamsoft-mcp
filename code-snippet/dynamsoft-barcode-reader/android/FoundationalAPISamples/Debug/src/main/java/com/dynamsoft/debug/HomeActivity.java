package com.dynamsoft.debug;

import android.content.Intent;
import android.os.Bundle;

import androidx.appcompat.app.AppCompatActivity;

import com.dynamsoft.license.LicenseManager;

public class HomeActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_home);

        if (savedInstanceState == null) {
            LicenseManager.initLicense(
                    "DLS2eyJoYW5kc2hha2VDb2RlIjoiMjAwMDAxLTE2NDk4Mjk3OTI2MzUiLCJvcmdhbml6YXRpb25JRCI6IjIwMDAwMSIsInNlc3Npb25QYXNzd29yZCI6IndTcGR6Vm05WDJrcEQ5YUoifQ==",
                    (isSuccess, error) -> {
                        if (!isSuccess)
                            error.printStackTrace();
                    });
        }

        findViewById(R.id.btn_start_capturing).setOnClickListener(v -> {
            Intent intent = new Intent(this, CaptureActivity.class);
            startActivity(intent);
        });
    }
}