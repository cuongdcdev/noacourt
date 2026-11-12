//! RFC 8785 JSON canonicalization.
use serde_json::Value;

pub fn canonicalize(input: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(input).map_err(|error| error.to_string())?;
    let mut output = String::new();
    write_value(&value, &mut output)?;
    Ok(output)
}

fn write_value(value: &Value, output: &mut String) -> Result<(), String> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::String(value) => write_string(value, output),
        Value::Number(value) => {
            let number: f64 = value
                .to_string()
                .parse()
                .map_err(|_| "number out of range")?;
            if !number.is_finite() {
                return Err("number out of range".into());
            }
            output.push_str(ryu_js::Buffer::new().format(number));
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                write_value(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort_by_key(|key| key.encode_utf16().collect::<Vec<_>>());
            for (index, key) in keys.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                write_string(key, output);
                output.push(':');
                let value = values
                    .get(key.as_str())
                    .ok_or("canonicalization key missing")?;
                write_value(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn write_string(value: &str, output: &mut String) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{0009}' => output.push_str("\\t"),
            '\u{000a}' => output.push_str("\\n"),
            '\u{000c}' => output.push_str("\\f"),
            '\u{000d}' => output.push_str("\\r"),
            c if c <= '\u{001f}' => output.push_str(&format!("\\u{:04x}", c as u32)),
            c => output.push(c),
        }
    }
    output.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec_hash;

    #[test]
    fn same_spec_different_key_order() {
        let first = canonicalize(r#"{"b":1,"a":2}"#).unwrap();
        let second = canonicalize(r#"{"a":2,"b":1}"#).unwrap();
        assert_eq!(first, second);
        assert_eq!(spec_hash(&first), spec_hash(&second));
    }
}
