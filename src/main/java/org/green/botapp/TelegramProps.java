package org.green.botapp;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "telegram.bot")
@Data
public class TelegramProps {
    private String token;
    private String name;
}